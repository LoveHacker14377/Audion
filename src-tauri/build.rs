fn main() {
    // Link libc++ for Android targets — required by native dependencies
    // that compile C++ code (e.g., audio decoders in symphonia/rodio).
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "android" {
        println!("cargo:rustc-link-lib=c++_shared");
    }

    tauri_build::build()
}
