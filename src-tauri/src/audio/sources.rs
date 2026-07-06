use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use std::num::NonZero;
use std::f32::consts::PI;
use crossbeam::channel::Receiver;
use rodio::Source;

use super::dsp::{EqSettings, FilterBank};

// =============================================================================
// PausableQueue — wraps queue output, emits silence when paused
// =============================================================================

pub struct PausableQueue<S: Source<Item = f32>> {
    pub inner: S,
    pub paused: Arc<AtomicBool>,
    pub frame_pos: usize,
}

impl<S: Source<Item = f32>> Iterator for PausableQueue<S> {
    type Item = f32;
    #[inline]
    fn next(&mut self) -> Option<f32> {
        let is_paused = self.paused.load(Ordering::Relaxed);

        if is_paused {
            let channels = self.inner.channels().get() as usize;
            self.frame_pos = (self.frame_pos + 1) % channels;
            return Some(0.0);
        }

        if self.frame_pos != 0 {
            let channels = self.inner.channels().get() as usize;
            self.frame_pos = (self.frame_pos + 1) % channels;
            return Some(0.0);
        }

        self.inner.next()
    }
}

impl<S: Source<Item = f32>> Source for PausableQueue<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> NonZero<u16> {
        self.inner.channels()
    }
    fn sample_rate(&self) -> NonZero<u32> {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

// =============================================================================
// CrossfadeState — owned crossfade buffer, lives exclusively on the audio thread
// =============================================================================

pub struct CrossfadeState {
    pub buffer: Vec<f32>,
    pub pos: usize,
    pub total_samples: usize,
}

// =============================================================================
// CrossfadeSource — wraps inner Source, mixes with crossfade buffer when active
// =============================================================================

pub struct CrossfadeSource<S: Source<Item = f32>> {
    pub inner: S,
    pub active: Arc<AtomicBool>,
    pub pending: Arc<Mutex<Option<CrossfadeState>>>,
    pub local: Option<CrossfadeState>,
}

impl<S: Source<Item = f32>> CrossfadeSource<S> {
    pub fn new(
        inner: S,
        active: Arc<AtomicBool>,
        pending: Arc<Mutex<Option<CrossfadeState>>>,
    ) -> Self {
        Self { inner, active, pending, local: None }
    }
}

impl<S: Source<Item = f32>> Iterator for CrossfadeSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        let sample = self.inner.next()?;

        if !self.active.load(Ordering::Acquire) {
            return Some(sample);
        }

        if self.local.is_none() {
            self.local = self.pending.lock().unwrap().take();
        }

        if let Some(ref mut cf) = self.local {
            if cf.pos < cf.total_samples {
                let progress = cf.pos as f32 / cf.total_samples as f32;
                let fade_out = (progress * PI * 0.5).cos();
                let fade_in  = (progress * PI * 0.5).sin();
                let next_sample = cf.buffer[cf.pos];
                cf.pos += 1;
                return Some((sample * fade_out + next_sample * fade_in).clamp(-1.0, 1.0));
            }
            self.local = None;
            self.active.store(false, Ordering::Relaxed);
        }

        Some(sample)
    }
}

impl<S: Source<Item = f32>> Source for CrossfadeSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> NonZero<u16> {
        self.inner.channels()
    }
    fn sample_rate(&self) -> NonZero<u32> {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

// =============================================================================
// EqSource — wraps inner Source (now CrossfadeSource), applies EQ in the audio callback
// =============================================================================

pub struct EqSource<S: Source<Item = f32>> {
    pub inner: S,
    pub bank: FilterBank,
    pub eq_settings: EqSettings,
    pub eq_rx: Receiver<EqSettings>,
    pub channels: usize,
    pub sample_rate: NonZero<u32>,
    pub current_ch: usize,
    pub frame_count: usize,
}

impl<S: Source<Item = f32>> EqSource<S> {
    pub fn new(inner: S, settings: &EqSettings, eq_rx: Receiver<EqSettings>) -> Self {
        let channels = inner.channels().get() as usize;
        let sample_rate = inner.sample_rate();
        let mut bank = FilterBank::new(channels, sample_rate);
        bank.rebuild(settings);
        Self {
            inner,
            bank,
            eq_settings: settings.clone(),
            eq_rx,
            channels,
            sample_rate,
            current_ch: 0,
            frame_count: 0,
        }
    }
}

impl<S: Source<Item = f32>> Iterator for EqSource<S> {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if self.frame_count == 0 {
            let mut latest: Option<EqSettings> = None;
            while let Ok(s) = self.eq_rx.try_recv() {
                latest = Some(s);
            }
            if let Some(s) = latest {
                self.eq_settings = s;
                self.bank.rebuild(&self.eq_settings);
            }

            let new_rate = self.inner.sample_rate();
            if new_rate != self.sample_rate {
                self.sample_rate = new_rate;
                self.bank
                    .rebuild_for_rate(self.channels, new_rate, &self.eq_settings);
            }

            self.frame_count = (self.sample_rate.get() as usize / 100).max(1) * self.channels;
        }
        self.frame_count -= 1;

        let ch_now = self.inner.channels().get() as usize;
        if ch_now != self.channels {
            self.channels = ch_now;
            self.current_ch = 0;
            self.bank
                .rebuild_for_rate(self.channels, self.sample_rate, &self.eq_settings);
        }

        let sample = self.inner.next()?;
        let ch = self.current_ch;
        self.current_ch = (self.current_ch + 1) % self.channels;
        Some(self.bank.process(sample, ch))
    }
}

impl<S: Source<Item = f32>> Source for EqSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }
    fn channels(&self) -> NonZero<u16> {
        self.inner.channels()
    }
    fn sample_rate(&self) -> NonZero<u32> {
        self.inner.sample_rate()
    }
    fn total_duration(&self) -> Option<Duration> {
        None
    }
    fn try_seek(&mut self, pos: Duration) -> Result<(), rodio::source::SeekError> {
        self.inner.try_seek(pos)
    }
}
