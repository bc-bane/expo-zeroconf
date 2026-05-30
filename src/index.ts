import { NativeModule, requireNativeModule, EventEmitter, SharedObject } from "expo";

type Subscription = { remove: () => void };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A service discovered and fully resolved on the local network via ZeroConf.
 */
export type ZeroconfService = {
  /** The unique name of the service (e.g. "My printer"). */
  name: string;
  /** The service type (e.g. "_http._tcp"). */
  type: string;
  /** The domain (usually "local."). */
  domain: string;
  /** The fully qualified hostname of the service (e.g. "My-printer.local."). */
  host?: string;
  /** The port number the service is listening on. */
  port?: number;
  /** Resolved IP addresses (both IPv4 and IPv6) associated with the service. */
  addresses?: string[];
  /** TXT record key-value pairs decoded from Base64. */
  txt?: Record<string, string>;
  /** Raw Base64-encoded TXT record key-value pairs. */
  txtRaw?: Record<string, string>;
};

export type ZeroconfEvent =
  | { action: "added"; service: ZeroconfService }
  | { action: "resolved"; service: ZeroconfService }
  | { action: "removed"; serviceName: string };

/**
 * Commonly-used mDNS Bonjour service types for discovery.
 */
export const ServiceTypes = {
  HTTP: "http",
  HTTPS: "https",
  PRINTER: "printer",
  IPP: "ipp",
  IPPS: "ipps",
  AIRPLAY: "airplay",
  AIRTUNES: "raop", // Remote Audio Output Protocol
  GOOGLE_CAST: "googlecast",
  HOMEKIT: "hap", // HomeKit Accessory Protocol
  SPOTIFY_CONNECT: "spotify-connect",
  SSH: "ssh",
  SFTP: "sftp",
  WORKSTATION: "workstation",
  FTP: "ftp",
  WEBDAV: "webdav",
  COAP: "coap",
  MQTT: "mqtt",
  DNS_SD: "services.dns-sd", // Discover all available service types
} as const;

export type ServiceType = (typeof ServiceTypes)[keyof typeof ServiceTypes];

/**
 * Options passed to `scan` and `scanStream`.
 */
export type ScanOptions = {
  /**
   * The domain to search in.
   * @default "local."
   */
  domain?: string;
  /**
   * The protocol to discover (e.g. "tcp" or "udp").
   * @default "tcp"
   */
  protocol?: "tcp" | "udp";
  /**
   * The scan timeout duration in milliseconds.
   * @default 5000
   */
  timeoutMs?: number;
  /**
   * Automatically resolve host, port, IP addresses, and TXT records.
   * If false, only service names are discovered, saving network traffic and battery.
   * @default true
   */
  autoResolve?: boolean;
};

/**
 * Options passed to `publishService` or class `publish`.
 */
export type PublishOptions = {
  /** The unique name for this service instance (e.g. "My Custom API"). */
  name: string;
  /** The service type (e.g. "http", "printer", "sssdp"). */
  type: string;
  /**
   * The protocol (e.g. "tcp" or "udp").
   * @default "tcp"
   */
  protocol?: "tcp" | "udp";
  /**
   * The domain.
   * @default "local."
   */
  domain?: string;
  /** The port the service is running on. */
  port: number;
  /** Optional dictionary of strings for TXT record mapping. */
  txt?: Record<string, string>;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the native ZeroConf module is not loaded or available.
 */
export class ZeroconfUnavailableError extends Error {
  constructor() {
    super(
      "[expo-zeroconf] Native module is not available. " +
        "Ensure you are running on a physical device or simulator with the native module installed."
    );
    this.name = "ZeroconfUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Native Module Binding
// ---------------------------------------------------------------------------

type ExpoZeroconfModuleType = InstanceType<typeof NativeModule> & {
  startScan(scanId: string, type: string, domain: string, autoResolve: boolean): void;
  stopScan(scanId: string): void;
  publish(options: {
    name: string;
    type: string;
    domain: string;
    port: number;
    txt: Record<string, string>;
  }): Promise<any>;
  unpublishService(name: string, type: string): Promise<void>;
  resolveService(name: string, type: string, domain: string): Promise<any>;
  PublishedService: any;
};

let NativeZeroconf: ExpoZeroconfModuleType | null = null;

try {
  NativeZeroconf = requireNativeModule<ExpoZeroconfModuleType>("ExpoZeroconf");
} catch {
  NativeZeroconf = null;
}

export const isAvailable = NativeZeroconf != null;

const emitter = NativeZeroconf ? new EventEmitter<Record<string, any>>(NativeZeroconf) : null;

// ---------------------------------------------------------------------------
// JSI Published Service Shared Object
// ---------------------------------------------------------------------------

/**
 * A JSI-backed SharedObject representing an actively registered mDNS service.
 * Destroys/unpublishes itself automatically upon garbage collection or calling `.unpublish()`.
 */
export class PublishedService extends ((NativeZeroconf?.PublishedService ?? SharedObject) as typeof SharedObject) {
  declare name: string;
  declare type: string;

  /**
   * Unregisters this service synchronously over JSI.
   */
  unpublish(): void {
    // @ts-ignore
    super.unpublish();
  }
}

// ---------------------------------------------------------------------------
// Internal Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const randomStr = Math.random().toString(36).substring(2, 9);
  return `zc-${Date.now()}-${randomStr}`;
}

function formatServiceType(type: string, protocol: string = "tcp"): string {
  let cleanType = type.trim().replace(/^\.+|\.+$/g, "");
  const hasProtocol = cleanType.includes("._tcp") || cleanType.includes("._udp");
  if (!cleanType.startsWith("_")) {
    cleanType = `_${cleanType}`;
  }
  if (hasProtocol) {
    return `${cleanType}.`;
  }
  let cleanProto = protocol.trim().replace(/^\.+|\.+$/g, "");
  if (!cleanProto.startsWith("_")) {
    cleanProto = `_${cleanProto}`;
  }
  return `${cleanType}.${cleanProto}.`;
}

function normalizeScanOptions(options: ScanOptions) {
  return {
    domain: options.domain ?? "local.",
    protocol: options.protocol ?? "tcp",
    timeoutMs: options.timeoutMs ?? 5000,
    autoResolve: options.autoResolve ?? true,
  };
}

function decodeBase64ToUtf8(base64Str: string): string {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(base64Str, "base64").toString("utf8");
    }
    const binaryString = atob(base64Str);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    try {
      return atob(base64Str);
    } catch {
      return base64Str;
    }
  }
}

function encodeStringToBase64(str: string): string {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(str, "utf8").toString("base64");
    }
    const bytes = new TextEncoder().encode(str);
    let binString = "";
    for (let i = 0; i < bytes.length; i++) {
      binString += String.fromCharCode(bytes[i]);
    }
    return btoa(binString);
  } catch {
    return btoa(str);
  }
}

function mapNativeService(nativeSvc: any): ZeroconfService {
  if (!nativeSvc) return nativeSvc;
  const txtRaw = nativeSvc.txt ?? {};
  const txtDecoded: Record<string, string> = {};
  for (const [key, base64Val] of Object.entries(txtRaw)) {
    txtDecoded[key] = decodeBase64ToUtf8(base64Val as string);
  }
  return {
    ...nativeSvc,
    txt: txtDecoded,
    txtRaw,
  };
}

// ---------------------------------------------------------------------------
// Modern Functional APIs — Promises and Async Generators (P1)
// ---------------------------------------------------------------------------

/**
 * Performs a ZeroConf service scan and returns a list of all resolved services
 * discovered within `timeoutMs`.
 */
export async function scan(type: string, options: ScanOptions = {}): Promise<ZeroconfService[]> {
  if (!NativeZeroconf) throw new ZeroconfUnavailableError();
  const services: ZeroconfService[] = [];
  for await (const service of scanStream(type, options)) {
    services.push(service);
  }
  return services;
}

/**
 * Progressive ZeroConf scanner yielding services in real-time as they are resolved.
 */
export async function* scanStream(
  type: string,
  options: ScanOptions = {}
): AsyncGenerator<ZeroconfService, void, undefined> {
  if (!NativeZeroconf || !emitter) throw new ZeroconfUnavailableError();

  const scanId = generateId();
  const normalized = normalizeScanOptions(options);
  const formattedType = formatServiceType(type, normalized.protocol);

  const queue: ZeroconfService[] = [];
  let done = false;
  let scanError: Error | null = null;
  let wakeUp: (() => void) | null = null;

  const signal = () => {
    const fn = wakeUp;
    wakeUp = null;
    fn?.();
  };

  let timeoutTimer: NodeJS.Timeout | null = null;

  const handleServiceFound = (e: { scanId: string; service: any }) => {
    if (e.scanId !== scanId) return;
    if (!normalized.autoResolve) {
      queue.push(mapNativeService(e.service));
      signal();
    }
  };

  const handleServiceResolved = (e: { scanId: string; service: any }) => {
    if (e.scanId !== scanId) return;
    if (normalized.autoResolve) {
      queue.push(mapNativeService(e.service));
      signal();
    }
  };

  const subs: Subscription[] = [
    emitter.addListener("onServiceFound", handleServiceFound),
    emitter.addListener("onServiceResolved", handleServiceResolved),
    emitter.addListener("onScanStopped", (e: { scanId: string }) => {
      if (e.scanId !== scanId) return;
      done = true;
      signal();
    }),
    emitter.addListener("onScanError", (e: { scanId: string; error: string }) => {
      if (e.scanId !== scanId) return;
      scanError = new Error(e.error);
      done = true;
      signal();
    }),
  ];

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    subs.forEach((s) => s.remove());
    NativeZeroconf?.stopScan(scanId);
  };

  try {
    NativeZeroconf.startScan(scanId, formattedType, normalized.domain, normalized.autoResolve);

    // Timeout safety trigger
    timeoutTimer = setTimeout(() => {
      done = true;
      signal();
    }, normalized.timeoutMs);

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
      });
      if (scanError) throw scanError;
    }

    while (queue.length > 0) yield queue.shift()!;
  } finally {
    cleanup();
  }
}

/**
 * Advanced event-driven scanner yielding add/update/removal notifications in real-time.
 */
export async function* scanStreamEvents(
  type: string,
  options: ScanOptions = {}
): AsyncGenerator<ZeroconfEvent, void, undefined> {
  if (!NativeZeroconf || !emitter) throw new ZeroconfUnavailableError();

  const scanId = generateId();
  const normalized = normalizeScanOptions(options);
  const formattedType = formatServiceType(type, normalized.protocol);

  const queue: ZeroconfEvent[] = [];
  let done = false;
  let scanError: Error | null = null;
  let wakeUp: (() => void) | null = null;

  const signal = () => {
    const fn = wakeUp;
    wakeUp = null;
    fn?.();
  };

  let timeoutTimer: NodeJS.Timeout | null = null;

  const handleServiceFound = (e: { scanId: string; service: any }) => {
    if (e.scanId !== scanId) return;
    queue.push({ action: "added", service: mapNativeService(e.service) });
    signal();
  };

  const handleServiceResolved = (e: { scanId: string; service: any }) => {
    if (e.scanId !== scanId) return;
    queue.push({ action: "resolved", service: mapNativeService(e.service) });
    signal();
  };

  const handleServiceRemoved = (e: { scanId: string; name: string }) => {
    if (e.scanId !== scanId) return;
    queue.push({ action: "removed", serviceName: e.name });
    signal();
  };

  const subs: Subscription[] = [
    emitter.addListener("onServiceFound", handleServiceFound),
    emitter.addListener("onServiceResolved", handleServiceResolved),
    emitter.addListener("onServiceRemoved", handleServiceRemoved),
    emitter.addListener("onScanStopped", (e: { scanId: string }) => {
      if (e.scanId !== scanId) return;
      done = true;
      signal();
    }),
    emitter.addListener("onScanError", (e: { scanId: string; error: string }) => {
      if (e.scanId !== scanId) return;
      scanError = new Error(e.error);
      done = true;
      signal();
    }),
  ];

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    subs.forEach((s) => s.remove());
    NativeZeroconf?.stopScan(scanId);
  };

  try {
    NativeZeroconf.startScan(scanId, formattedType, normalized.domain, normalized.autoResolve);

    // Timeout safety trigger
    timeoutTimer = setTimeout(() => {
      done = true;
      signal();
    }, normalized.timeoutMs);

    while (true) {
      while (queue.length > 0) yield queue.shift()!;
      if (done) break;
      await new Promise<void>((resolve) => {
        wakeUp = resolve;
      });
      if (scanError) throw scanError;
    }

    while (queue.length > 0) yield queue.shift()!;
  } finally {
    cleanup();
  }
}

/**
 * Resolves a discovered service's hostname, IP addresses, port, and TXT records.
 * Use this for dynamic, on-demand resolution when `autoResolve` scan option is false.
 */
export async function resolveService(
  name: string,
  type: string,
  domain: string = "local."
): Promise<ZeroconfService> {
  if (!NativeZeroconf) throw new ZeroconfUnavailableError();
  const formattedType = formatServiceType(type, "tcp");
  const nativeSvc = await NativeZeroconf.resolveService(name, formattedType, domain);
  return mapNativeService(nativeSvc);
}

/**
 * Registers/publishes a ZeroConf service on the local network.
 * Returns a JSI-backed `PublishedService` SharedObject connection representing the active registration.
 */
export async function publishService(options: PublishOptions): Promise<PublishedService> {
  if (!NativeZeroconf) throw new ZeroconfUnavailableError();
  const protocol = options.protocol ?? "tcp";
  const domain = options.domain ?? "local.";
  const formattedType = formatServiceType(options.type, protocol);

  const base64Txt: Record<string, string> = {};
  if (options.txt) {
    for (const [key, val] of Object.entries(options.txt)) {
      base64Txt[key] = encodeStringToBase64(val);
    }
  }

  return NativeZeroconf.publish({
    name: options.name,
    type: formattedType,
    domain,
    port: options.port,
    txt: base64Txt,
  });
}

/**
 * Unpublishes a service by its name and type.
 */
export async function unpublishService(name: string, type: string, protocol: "tcp" | "udp" = "tcp"): Promise<void> {
  if (!NativeZeroconf) throw new ZeroconfUnavailableError();
  const formattedType = formatServiceType(type, protocol);
  await NativeZeroconf.unpublishService(name, formattedType);
}

// ---------------------------------------------------------------------------
// Backward-Compatible Event Emitter and Zeroconf Class Wrapper
// ---------------------------------------------------------------------------

type Callback = (...args: any[]) => void;

class CustomEventEmitter {
  private listeners: Record<string, Callback[]> = {};

  on(event: string, callback: Callback): this {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
    return this;
  }

  off(event: string, callback: Callback): this {
    if (!this.listeners[event]) return this;
    this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
    return this;
  }

  addListener(event: string, callback: Callback): this {
    return this.on(event, callback);
  }

  removeListener(event: string, callback: Callback): this {
    return this.off(event, callback);
  }

  removeAllListeners(event?: string): this {
    if (event) {
      delete this.listeners[event];
    } else {
      this.listeners = {};
    }
    return this;
  }

  emit(event: string, ...args: any[]): boolean {
    if (!this.listeners[event] || this.listeners[event].length === 0) return false;
    this.listeners[event].forEach((cb) => cb(...args));
    return true;
  }
}

/**
 * Compatibility class mimicking the original class-based react-native-zeroconf API.
 */
export default class Zeroconf extends CustomEventEmitter {
  private activeScanId: string | null = null;
  private servicesMap = new Map<string, ZeroconfService>();
  private nativeSubs: Subscription[] = [];
  private publishedServices = new Map<string, PublishedService>();

  constructor() {
    super();
    this.setupNativeListeners();
  }

  private setupNativeListeners() {
    if (!emitter) return;

    this.nativeSubs = [
      emitter.addListener(
        "onServiceFound",
        (e: { scanId: string; service: any }) => {
          if (e.scanId !== this.activeScanId) return;
          const service = mapNativeService(e.service);
          this.emit("found", service.name);
        }
      ),
      emitter.addListener(
        "onServiceResolved",
        (e: { scanId: string; service: any }) => {
          if (e.scanId !== this.activeScanId) return;
          const service = mapNativeService(e.service);
          this.servicesMap.set(service.name, service);
          this.emit("resolved", service);
          this.emit("update");
        }
      ),
      emitter.addListener(
        "onServiceRemoved",
        (e: { scanId: string; name: string }) => {
          if (e.scanId !== this.activeScanId) return;
          this.servicesMap.delete(e.name);
          this.emit("remove", e.name);
          this.emit("update");
        }
      ),
      emitter.addListener("onScanError", (e: { scanId: string; error: string }) => {
        if (e.scanId !== this.activeScanId) return;
        this.emit("error", new Error(e.error));
      }),
      emitter.addListener("onScanStopped", (e: { scanId: string }) => {
        if (e.scanId !== this.activeScanId) return;
        this.emit("stop");
      }),
    ];
  }

  /**
   * Returns a map/dictionary of resolved services. Key is the service name.
   */
  getServices(): Record<string, ZeroconfService> {
    const services: Record<string, ZeroconfService> = {};
    this.servicesMap.forEach((svc, name) => {
      services[name] = svc;
    });
    return services;
  }

  /**
   * Returns a flat array of all currently resolved services.
   * Facilitates clean map/filter operations in functional UI lists.
   */
  getServicesList(): ZeroconfService[] {
    return Array.from(this.servicesMap.values());
  }

  /**
   * Starts a service scan (backward-compatible signature).
   */
  scan(type: string = "http", protocol: string = "tcp", domain: string = "local.") {
    if (!NativeZeroconf) {
      this.emit("error", new ZeroconfUnavailableError());
      return;
    }

    this.stop();
    this.servicesMap.clear();

    const scanId = generateId();
    this.activeScanId = scanId;
    const formattedType = formatServiceType(type, protocol);

    try {
      NativeZeroconf.startScan(scanId, formattedType, domain, true);
      this.emit("start");
    } catch (e: any) {
      this.emit("error", e);
    }
  }

  /**
   * Stops the current active scan.
   */
  stop() {
    if (this.activeScanId && NativeZeroconf) {
      try {
        NativeZeroconf.stopScan(this.activeScanId);
        this.emit("stop");
      } catch (e: any) {
        this.emit("error", e);
      }
      this.activeScanId = null;
    }
  }

  /**
   * Publishes a service using old-style parameters.
   */
  async publish(
    type: string,
    protocol: string,
    domain: string,
    name: string,
    port: number,
    txt: Record<string, string> = {}
  ): Promise<void> {
    try {
      const pubSvc = await publishService({
        name,
        type,
        protocol: protocol as "tcp" | "udp",
        domain,
        port,
        txt,
      });
      // Store reference so we can unpublish it by name
      this.publishedServices.set(name, pubSvc);
    } catch (e: any) {
      this.emit("error", e);
      throw e;
    }
  }

  /**
   * Unpublishes a service by its name.
   */
  async unpublish(name: string): Promise<void> {
    const pubSvc = this.publishedServices.get(name);
    if (pubSvc) {
      pubSvc.unpublish();
      this.publishedServices.delete(name);
    }
  }

  /**
   * Cleans up all listeners and stops scanning.
   */
  removeDeviceListeners() {
    this.stop();
    this.nativeSubs.forEach((s) => s.remove());
    this.nativeSubs = [];
  }

  /**
   * Re-binds native listeners if they were removed.
   */
  addDeviceListeners() {
    this.removeDeviceListeners();
    this.setupNativeListeners();
  }

  /**
   * Manually resolves a found service by name, type, and domain.
   */
  async resolveService(name: string, type: string, domain: string = "local."): Promise<ZeroconfService> {
    return await resolveService(name, type, domain);
  }
}

