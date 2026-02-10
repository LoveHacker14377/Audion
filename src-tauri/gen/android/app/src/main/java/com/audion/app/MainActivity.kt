package com.audion.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onPluginsLoaded() {
    // Register custom permissions plugin for audio file access
    registerPlugin(PermissionsPlugin::class.java)
  }
}
