use std::f32::consts::PI;
use std::num::NonZero;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct EqBand {
    pub frequency: f32,
    pub gain: f32, // dB, -12..+12
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EqSettings {
    pub enabled: bool,
    pub bands: Vec<EqBand>,
}

impl Default for EqSettings {
    fn default() -> Self {
        let freqs = [
            31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
        ];
        Self {
            enabled: false,
            bands: freqs
                .iter()
                .map(|&f| EqBand {
                    frequency: f,
                    gain: 0.0,
                })
                .collect(),
        }
    }
}

const EQ_Q: f32 = 1.41;

#[derive(Clone)]
pub struct BiquadFilter {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadFilter {
    pub fn new_peaking(freq: f32, gain_db: f32, sample_rate: NonZero<u32>) -> Self {
        let a = 10.0f32.powf(gain_db / 40.0);
        let w0 = 2.0 * PI * freq / sample_rate.get() as f32;
        let alpha = w0.sin() / (2.0 * EQ_Q);
        let cos = w0.cos();

        let b0 = 1.0 + alpha * a;
        let b1 = -2.0 * cos;
        let b2 = 1.0 - alpha * a;
        let a0 = 1.0 + alpha / a;
        let a1 = -2.0 * cos;
        let a2 = 1.0 - alpha / a;

        Self::from_coeffs(b0, b1, b2, a0, a1, a2)
    }

    fn from_coeffs(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        if a0.abs() < 1e-10 {
            return Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0,
                        x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 };
        }
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

pub struct FilterBank {
    filters: Vec<Vec<BiquadFilter>>,
    channels: usize,
    sample_rate: NonZero<u32>,
}

impl FilterBank {
    pub fn new(channels: usize, sample_rate: NonZero<u32>) -> Self {
        Self {
            filters: vec![vec![]; channels],
            channels,
            sample_rate,
        }
    }

    pub fn rebuild(&mut self, settings: &EqSettings) {
        self.filters = vec![vec![]; self.channels];
        if settings.enabled {
            for ch in 0..self.channels {
                for band in &settings.bands {
                    if band.gain.abs() > 0.01 {
                        self.filters[ch].push(BiquadFilter::new_peaking(
                            band.frequency,
                            band.gain,
                            self.sample_rate,
                        ));
                    }
                }
            }
        }
    }

    pub fn rebuild_for_rate(&mut self, channels: usize, sample_rate: NonZero<u32>, settings: &EqSettings) {
        self.channels = channels;
        self.sample_rate = sample_rate;
        self.rebuild(settings);
    }

    #[inline]
    pub fn process(&mut self, sample: f32, channel: usize) -> f32 {
        let mut s = sample;
        for f in &mut self.filters[channel] {
            s = f.process(s);
        }
        s
    }
}
