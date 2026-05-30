# Changelog

All notable changes to this project will be documented in this file.

## [0.0.2] - 2026-05-29

### Added
- **`scanStreamEvents` API**: Added a new advanced progressive async generator yielding event objects `{ action: 'added' | 'resolved' | 'removed', ... }` to natively support device offline removal states in reactive UI lists.
- **Binary-Safe TXT Record Support**: Implemented base64 encoding/decoding pipeline natively (iOS and Android) and in the TS wrapper, eliminating dynamic UTF-8 data-loss/corruption on binary bitmasks and non-printable configuration fields (e.g. AirPlay, Chromecast).

### Fixed
- **iOS Concurrency & Threading**: Offloaded all `NetService` / `NetServiceBrowser` allocations, searches, and delegate callback processing to a dedicated shared background thread running a custom serial loop (`BonjourRunLoop`), eliminating UI thread congestion.
- **iOS Promise Leaks**: Safely reject all outstanding manual resolution and publishing promises on module teardown (`OnDestroy`).
- **Android Memory & GC Safety**: Removed deprecated JVM finalizers on `PublishedService` SharedObject, replacing them with a deterministic JSI GC `sharedObjectDidRelease()` callback to guarantee immediate service unpublishing.
- **Android Lifecycle Optimization**: Hooked into Android activity lifecycle states (`OnActivityEntersBackground` / `OnActivityEntersForeground`) to pause discovery listeners and release WiFi Multicast Locks (`MulticastLock`) in the background, conserving battery.
- **Android Resolve Worker Cooldown**: Added sequence queue delays and exponential retry backoffs (`200ms * attempt`) when hitting `FAILURE_ALREADY_ACTIVE` (code 3) to prevent Android system resolver queue locks.
- **Android Service Registration NPE**: Handled platform-specific `null` type states in the system `onServiceRegistered` callback using safe parameter fallbacks, preventing a fatal NullPointerException during service publishing.
- **Android Class Builder Constraint**: Declared a default class JSI `Constructor` builder for `PublishedService` to prevent `IllegalArgumentException` during Android module startup.

---

## [0.0.1] - 2026-05-29

### Added
- **Initial Release**: High-performance, JSI-powered Expo native module for ZeroConf/mDNS/DNS-SD service discovery and publishing.
- Support for React Native New Architecture (TurboModules / JSI).
- JSI-backed `PublishedService` `SharedObject` for robust native-to-JS lifecycle synchronization.
- Compatibility class wrapper replicating `react-native-zeroconf` class signatures.
- Expo config plugin (`app.plugin.js`) for plist Bonjour service registrations.
