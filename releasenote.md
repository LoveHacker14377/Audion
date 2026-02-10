## Release Note - 1.1.10b

### UI Refactor & Mobile Compatibility

We have refactored the user interface to improve usability, consistency, and performance across the app. Major changes include:

- Redesigned UI components for a cleaner and more modern look.
- Improved navigation and layout for both desktop and mobile devices.
- Enhanced responsiveness to ensure seamless experience on mobile platforms.
- Updated styles and interactions to support touch input and smaller screens.
- Fixed various bugs and optimized performance for mobile compatibility.

These changes make the app fully compatible with mobile devices, providing a unified experience across platforms. For more details, see the related git commit.

---

### Linux: EGL Display Error Fix

If you encounter the error `could not create surfaceless egl display bad alloc aborting` when running the AppImage on Linux, use one of these solutions:

**Quick fix:**
```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Audion.AppImage
```

**Most compatible (if the above doesn't work):**
```bash
WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Audion.AppImage
```

This is a WebKitGTK compatibility issue with certain GPU drivers. See the README for more details and permanent solutions.
