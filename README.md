# expo-zeroconf

A high-performance, JSI-powered Expo native module for ZeroConf/mDNS/DNS-SD service discovery, resolution, and publishing on local networks. 

Built entirely using the **Expo Modules API v2 (New Architecture / JSI-backed)**, this package eliminates old-style serialized React Native bridge overhead. It supports iOS (Swift via official `NetService` Foundation APIs) and Android (Kotlin via `NsdManager` with a robust concurrent-resolve blocking prevention queue).

- **Supports Android and iOS** (Fully native integration)
- **Zero Bridge Overhead**: Operates entirely over direct high-speed JSI (JavaScript Interface) bindings.
- **JSI SharedObject Lifecycle**: Modeled registrations as JSI `SharedObjects` which synchronously unpublish themselves over JSI upon garbage collection.
- **Modern React Native ready**: Full New Architecture / Turbo Module compatibility out of the box.
- **Sequential Resolve Queue (Android)**: Implements custom coroutine resolving to solve Android's infamous concurrent NSD `BUSY` conflict crashes.

---

> [!WARNING]
> **Expo Go Compatibility**
> Because this package utilizes custom native code (Kotlin on Android and Swift on iOS) to manage local sockets and systems, it **will not work** in the standard pre-compiled **Expo Go** application. 
> 
> To test and run this library, you must compile it into a **Development Build** (`expo-dev-client`) or run it in a vanilla React Native project.

---

## Installation

```sh
npm install expo-zeroconf
```

### Vanilla React Native Usage (Without Expo)

Yes! `expo-zeroconf` is built using the modern **Expo Modules API**, which works seamlessly in **vanilla React Native** projects. You do not need to boot or use the Expo CLI or Expo SDK.

To configure your vanilla React Native project to run Expo Modules, simply run:

```sh
npx install-expo-modules@latest
```

This single command will automatically configure your native Android and iOS folders to support the lightweight Expo Modules compilation layer. Once configured, you can use `expo-zeroconf` exactly like any other React Native library.

### iOS Setup

```sh
npx pod-install
```

No external CocoaPod dependencies. The library compiles directly on top of Apple's lightweight native `NetService` sockets.

---

## Native Setup & Permissions

### iOS

On **physical devices (iOS 14+)**, local network discovery is blocked unless configured in your `Info.plist`:

**1. Add `NSLocalNetworkUsageDescription` to `app.json` (or `Info.plist`):**
```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSLocalNetworkUsageDescription": "This app uses the local network to discover and register Bonjour / ZeroConf services."
      }
    }
  }
}
```

**2. Declare Bonjour Service types (`NSBonjourServices`):**
iOS requires you to explicitly declare which Bonjour service types you will be browsing or publishing. Add this in your `app.json`:
```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSBonjourServices": [
          "_http._tcp",
          "_printer._tcp",
          "_expo-test._tcp"
        ]
      }
    }
  }
}
```

### Android

No manual steps needed — the library's `AndroidManifest.xml` automatically merges the required permissions into your app:

- `android.permission.INTERNET`
- `android.permission.CHANGE_WIFI_MULTICAST_STATE` (required to acquire a MulticastLock, which enables Android Wi-Fi drivers to deliver multicast UDP packets to the app)

---

## Modern Functional JS/TS API

We recommend using the modern Promise and Async Generator APIs for cleaner code in React functional components.

### 1. Progressive Scanning (Async Generator)

Using `scanStream` (Async Generator) allows you to progressively yield services in real-time as they are discovered and resolved, rather than waiting for the entire timeout to elapse:

```typescript
import { scanStream } from "expo-zeroconf";

// Progressive scan for HTTP TCP services
const stream = scanStream("http", { timeoutMs: 8000 });

try {
  for await (const service of stream) {
    console.log("Resolved service progressively:", service.name);
    console.log("IP Addresses:", service.addresses); // ["192.168.1.150"]
    console.log("Port:", service.port); // 80
    console.log("TXT Records:", service.txt); // { "path": "/api" }
  }
} catch (err) {
  console.error("Scan stopped with error:", err);
}
```

To cancel an active stream early (e.g., if a user presses a cancel button or navigates away), call `.return()`:
```typescript
await stream.return(undefined); // Closes native sockets and cancels immediately
```

### 2. Static Scanning (Promise-based)

If you just want to scan for a fixed duration and resolve with a static list of all discovered and resolved services:

```typescript
import { scan } from "expo-zeroconf";

const services = await scan("http", { timeoutMs: 5000 });
console.log("Discovered services:", services);
```

### 3. Publishing a Service (JSI SharedObject)

To advertise/register a service on the local network, call `publishService`. It resolves with a JSI-backed `PublishedService` SharedObject representing the active registration:

```typescript
import { publishService } from "expo-zeroconf";

const service = await publishService({
  name: "My custom API",
  type: "http",
  port: 8080,
  txt: { version: "1.0.0", secure: "false" }
});

// To unpublish:
service.unpublish();
```

> [!TIP]
> **Garbage Collection Safety**
> If the `PublishedService` instance falls out of scope and is garbage collected by the JavaScript engine, it will automatically call the native unpublish routines synchronously over JSI to prevent stale network advertisements.

---

## Backward-Compatible Drop-In API

We also export a class-based compatibility layer that perfectly mirrors the API from `react-native-zeroconf`, letting you swap libraries without modifying your existing app flows:

```typescript
import Zeroconf from "expo-zeroconf";

const zeroconf = new Zeroconf();

// Event listeners
zeroconf.on("start", () => console.log("Scan started"));
zeroconf.on("stop", () => console.log("Scan stopped"));
zeroconf.on("found", (name) => console.log("Discovered service name:", name));
zeroconf.on("resolved", (service) => {
  console.log("Resolved Service details:", service.name, service.addresses, service.port);
});
zeroconf.on("remove", (name) => console.log("Service went offline:", name));
zeroconf.on("error", (error) => console.error("mDNS error:", error));

// Start scanning
zeroconf.scan("http");

// Stop scanning
zeroconf.stop();

// Publish a service
await zeroconf.publish("http", "tcp", "local.", "My Server", 8080, { path: "/" });

// Unpublish service
await zeroconf.unpublish("My Server");

// Get currently resolved services as a map/dictionary
const servicesMap = zeroconf.getServices(); // { "My Printer": serviceData }

// Get currently resolved services as a flat array
const servicesArray = zeroconf.getServicesList(); // [ serviceData ]

// Clean up listeners on component unmount
zeroconf.removeDeviceListeners();
```

---

## 📦 Preset Bonjour Service Types

To facilitate fast, zero-memorization scanning and prevent type string formatting errors, we export a **`ServiceTypes`** preset dictionary. Use these when calling `scan()` or `scanStream()`:

```typescript
import { scan, ServiceTypes } from "expo-zeroconf";

// Easily scan for Google Cast / Chromecast devices
const chromecasts = await scan(ServiceTypes.GOOGLE_CAST);

// Presets available:
ServiceTypes.HTTP;           // "http"
ServiceTypes.HTTPS;          // "https"
ServiceTypes.PRINTER;        // "printer"
ServiceTypes.IPP;            // "ipp" (Internet Printing Protocol)
ServiceTypes.IPPS;           // "ipps"
ServiceTypes.AIRPLAY;        // "airplay"
ServiceTypes.AIRTUNES;       // "raop" (AirPort Express Audio)
ServiceTypes.GOOGLE_CAST;    // "googlecast"
ServiceTypes.HOMEKIT;        // "hap" (HomeKit Accessory)
ServiceTypes.SPOTIFY_CONNECT;// "spotify-connect"
ServiceTypes.SSH;            // "ssh"
ServiceTypes.SFTP;           // "sftp"
ServiceTypes.WORKSTATION;    // "workstation"
ServiceTypes.DNS_SD;         // "services.dns-sd" (Discover all local service types)
```

---

## Troubleshooting

**No devices found during scanning:**
- Ensure your test device is on the same physical Wi-Fi network as the target devices.
- **iOS Local Network Permission**: Verify you accepted the local network dialog prompt.
- **iOS Bonjour Services**: Make sure the target service type is registered in `NSBonjourServices` inside your `Info.plist` (or `app.json` plugins).
- **Android Emulator**: Android emulators sit behind a virtual NAT router and generally cannot receive local network multicast packets. **You must test on a physical Android device**.
- Try increasing `timeoutMs` to `10000` or `15000` on slow networks.
- Corporates or Guest Wi-Fi networks frequently block multicast/broadcast traffic.

---

## License

MIT
