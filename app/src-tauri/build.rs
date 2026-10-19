//! Tauri's build step, and on Windows (MSVC) the application manifest for
//! every binary of this crate, test binaries included.
//!
//! `tauri_build` puts the manifest - the dependency on Common Controls 6 -
//! into a resource linked into the crate's `bin` targets only. The library's
//! test binary then has none, and Windows refuses to start it the moment it
//! links a function only Common Controls 6 has (the tray's and menus'
//! `LoadIconMetric`, which R3.8's tests reach through Tauri's mock app):
//! `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) before `main`, so no test runs
//! and none is named. So the manifest is left out of the resource and handed
//! to the linker for every target instead (Tauri's own workaround, its
//! `examples/api`): the app's executable gets the same manifest as before,
//! the test binaries get it too. `windows-app-manifest.xml` is tauri-build's
//! own (2.6.3).

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    let msvc = target_os == "windows" && target_env == "msvc";
    let mut attributes = tauri_build::Attributes::new();
    if msvc {
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    if let Err(error) = tauri_build::try_build(attributes) {
        panic!("tauri-build: {error:#}");
    }
    if msvc {
        let manifest =
            std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
