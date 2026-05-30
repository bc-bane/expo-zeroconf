import ExpoModulesCore
import Foundation

// ---------------------------------------------------------------------------
// Thread-Safe Background Run Loop for Bonjour
// ---------------------------------------------------------------------------

internal final class BonjourRunLoop: Thread {
  private var runLoop: RunLoop?
  private let initSemaphore = DispatchSemaphore(value: 0)
  
  static let shared: BonjourRunLoop = {
    let thread = BonjourRunLoop()
    thread.start()
    return thread
  }()
  
  override func main() {
    self.name = "com.expo.zeroconf.bonjourRunLoop"
    self.runLoop = RunLoop.current
    
    // Add a dummy Port to keep the RunLoop alive indefinitely
    RunLoop.current.add(NSMachPort(), forMode: .default)
    initSemaphore.signal()
    
    while !isCancelled {
      RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
    }
  }
  
  func execute(_ block: @escaping () -> Void) {
    initSemaphore.wait()
    guard let rl = self.runLoop else {
      initSemaphore.signal()
      return
    }
    initSemaphore.signal()
    
    CFRunLoopPerformBlock(rl.getCFRunLoop(), CFRunLoopMode.defaultMode.rawValue, block)
    CFRunLoopWakeUp(rl.getCFRunLoop())
  }
}

// ---------------------------------------------------------------------------
// Published Service Shared Object
// ---------------------------------------------------------------------------

internal final class PublishedServiceDelegate: NSObject, NetServiceDelegate {
  private weak var owner: PublishedService?

  init(owner: PublishedService) {
    self.owner = owner
  }

  func netServiceDidPublish(_ sender: NetService) {
    owner?.netServiceDidPublish(sender)
  }

  func netService(_ sender: NetService, didNotPublish errorDict: [String : NSNumber]) {
    owner?.netService(sender, didNotPublish: errorDict)
  }

  func netServiceDidStop(_ sender: NetService) {
    owner?.netServiceDidStop(sender)
  }
}

internal final class PublishedService: SharedObject {
  var name: String
  var type: String
  private let service: NetService
  private weak var module: ExpoZeroconfModule?
  fileprivate var pendingPromise: Promise?
  private var delegateHelper: PublishedServiceDelegate?

  init(name: String, type: String, service: NetService, module: ExpoZeroconfModule) {
    self.name = name
    self.type = type
    self.service = service
    self.module = module
    super.init()
    let delegate = PublishedServiceDelegate(owner: self)
    self.delegateHelper = delegate
    self.service.delegate = delegate
  }

  func unpublish() {
    BonjourRunLoop.shared.execute { [weak self] in
      guard let self = self else { return }
      self.service.stop()
      self.service.delegate = nil
      self.delegateHelper = nil
      self.module?.removePublishedService(self)
    }
  }

  deinit {
    let svc = self.service
    BonjourRunLoop.shared.execute {
      svc.delegate = nil
      svc.stop()
    }
  }

  // NetServiceDelegate
  func netServiceDidPublish(_ sender: NetService) {
    BonjourRunLoop.shared.execute { [weak self] in
      guard let self = self else { return }
      let oldKey = "\(self.name)|\(self.type)"
      self.name = sender.name
      self.type = sender.type
      let newKey = "\(sender.name)|\(sender.type)"
      
      if let module = self.module {
        module.pendingPublishServices.removeValue(forKey: oldKey)
        module.publishedServices[newKey] = self
        module.originalToResolvedKeys[oldKey] = newKey
      }
      
      self.pendingPromise?.resolve(self)
      self.pendingPromise = nil
    }
  }

  func netService(_ sender: NetService, didNotPublish errorDict: [String : NSNumber]) {
    BonjourRunLoop.shared.execute { [weak self] in
      guard let self = self else { return }
      let errorCode = errorDict[NetService.errorCode]?.intValue ?? -1
      self.pendingPromise?.reject("ERR_ZEROCONF_PUBLISH_FAILED", "Failed to publish service. Error code: \(errorCode)")
      self.pendingPromise = nil
      
      let key = "\(self.name)|\(self.type)"
      if let module = self.module {
        module.pendingPublishServices.removeValue(forKey: key)
      }
    }
  }

  func netServiceDidStop(_ sender: NetService) {
    // Graceful unpublish complete
  }
}

// ---------------------------------------------------------------------------
// Options Record
// ---------------------------------------------------------------------------

internal struct PublishOptions: Record {
  @Field var name: String = ""
  @Field var type: String = ""
  @Field var domain: String = "local."
  @Field var port: Int = 0
  @Field var txt: [String: String] = [:]
}

internal struct WeakPublishedService {
  weak var value: PublishedService?
}

internal final class ZeroconfDelegateCoordinator: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private weak var module: ExpoZeroconfModule?

  init(module: ExpoZeroconfModule) {
    self.module = module
  }

  // ----- NetServiceBrowserDelegate -----
  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    module?.netServiceBrowser(browser, didFind: service, moreComing: moreComing)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    module?.netServiceBrowser(browser, didRemove: service, moreComing: moreComing)
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
    module?.netServiceBrowser(browser, didNotSearch: errorDict)
  }

  // ----- NetServiceDelegate -----
  func netServiceDidResolveAddress(_ sender: NetService) {
    module?.netServiceDidResolveAddress(sender)
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
    module?.netService(sender, didNotResolve: errorDict)
  }

  func netService(_ sender: NetService, didUpdateTXTRecord data: Data) {
    module?.netService(sender, didUpdateTXTRecord: data)
  }
}

// ---------------------------------------------------------------------------
// Expo Zeroconf Native Module
// ---------------------------------------------------------------------------

public final class ExpoZeroconfModule: Module {
  private lazy var delegateCoordinator = ZeroconfDelegateCoordinator(module: self)
  private var browsers = [String: NetServiceBrowser]()            // scanId: browser
  private var activeResolvers = [String: [NetService]]()          // scanId: list of services being resolved
  private var serviceScanIds = [NetService: String]()             // service: scanId
  internal var publishedServices = [String: PublishedService]()    // "name|type": published service
  internal var pendingPublishServices = [String: PublishedService]()    // "name|type": pending service during publish handshake
  private var scanConfigs = [String: Bool]()                      // scanId: autoResolve
  private var scanParams = [String: (type: String, domain: String)]() // scanId: (type, domain)
  private var isScanningBeforeBackground = false
  private var manualResolvers = [NetService: Promise]()           // manual resolver netServices
  internal var originalToResolvedKeys = [String: String]()         // "originalName|type": "resolvedName|type"

  public func definition() -> ModuleDefinition {
    Name("ExpoZeroconf")

    Events(
      "onServiceFound",
      "onServiceResolved",
      "onServiceRemoved",
      "onScanStopped",
      "onScanError"
    )

    // JSI Class mapping for PublishedService
    Class(PublishedService.self) {
      Property("name") { (service: PublishedService) in
        return service.name
      }
      Property("type") { (service: PublishedService) in
        return service.type
      }
      Function("unpublish") { (service: PublishedService) in
        service.unpublish()
      }
    }

    Function("startScan") { (scanId: String, type: String, domain: String, autoResolve: Bool) in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else { return }
        
        self.scanConfigs[scanId] = autoResolve
        self.scanParams[scanId] = (type, domain)
        
        // Prevent duplicate browser leaks by stopping the previous browser if it exists
        if let oldBrowser = self.browsers.removeValue(forKey: scanId) {
          oldBrowser.stop()
        }
        
        let browser = NetServiceBrowser()
        browser.delegate = self.delegateCoordinator
        self.browsers[scanId] = browser
        
        browser.searchForServices(ofType: type, inDomain: domain)
      }
    }

    Function("stopScan") { (scanId: String) in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else { return }
        
        self.scanConfigs.removeValue(forKey: scanId)
        self.scanParams.removeValue(forKey: scanId)
        
        if let browser = self.browsers.removeValue(forKey: scanId) {
          browser.stop()
        }
        
        // Clean up any pending resolvers for this scanId
        if let resolvers = self.activeResolvers.removeValue(forKey: scanId) {
          for svc in resolvers {
            self.serviceScanIds.removeValue(forKey: svc)
            svc.delegate = nil
            svc.stop()
          }
        }
        
        self.sendEvent("onScanStopped", ["scanId": scanId])
      }
    }

    AsyncFunction("publish") { (options: PublishOptions, promise: Promise) in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else {
          promise.reject("ERR_ZEROCONF_MODULE_DEALLOCATED", "Native module was deallocated")
          return
        }
        
        let service = NetService(
          domain: options.domain,
          type: options.type,
          name: options.name,
          port: Int32(options.port)
        )
        
        // Decode base64 strings back to raw Data for binary safety
        var txtDataMap = [String: Data]()
        for (key, value) in options.txt {
          if let data = Data(base64Encoded: value) {
            txtDataMap[key] = data
          } else if let data = value.data(using: .utf8) {
            txtDataMap[key] = data
          }
        }
        let txtRecordData = NetService.data(fromTXTRecord: txtDataMap)
        service.setTXTRecord(txtRecordData)
        
        let key = "\(options.name)|\(options.type)"
        let pubSvc = PublishedService(name: options.name, type: options.type, service: service, module: self)
        pubSvc.pendingPromise = promise
        
        self.pendingPublishServices[key] = pubSvc
        
        service.publish()
      }
    }

    AsyncFunction("unpublishService") { (name: String, type: String, promise: Promise) in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else {
          promise.resolve()
          return
        }
        
        let originalKey = "\(name)|\(type)"
        let resolvedKey = self.originalToResolvedKeys.removeValue(forKey: originalKey) ?? originalKey
        
        if let pubSvc = self.publishedServices.removeValue(forKey: resolvedKey) {
          pubSvc.unpublish()
        } else if let pubSvc = self.pendingPublishServices.removeValue(forKey: originalKey) {
          pubSvc.unpublish()
        }
        promise.resolve()
      }
    }

    AsyncFunction("resolveService") { (name: String, type: String, domain: String, promise: Promise) in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else {
          promise.reject("ERR_ZEROCONF_MODULE_DEALLOCATED", "Native module was deallocated")
          return
        }
        
        let resolver = NetService(domain: domain, type: type, name: name)
        resolver.delegate = self.delegateCoordinator
        self.manualResolvers[resolver] = promise
        resolver.resolve(withTimeout: 5.0)
      }
    }

    OnAppEntersBackground { [weak self] in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else { return }
        
        if !self.browsers.isEmpty {
          self.isScanningBeforeBackground = true
          let activeScanIds = Array(self.browsers.keys)
          for scanId in activeScanIds {
            if let browser = self.browsers.removeValue(forKey: scanId) {
              browser.stop()
            }
            if let resolvers = self.activeResolvers.removeValue(forKey: scanId) {
              for svc in resolvers {
                self.serviceScanIds.removeValue(forKey: svc)
                svc.delegate = nil
                svc.stop()
              }
            }
            self.sendEvent("onScanStopped", ["scanId": scanId])
          }
        }
      }
    }

    OnAppEntersForeground { [weak self] in
      BonjourRunLoop.shared.execute { [weak self] in
        guard let self = self else { return }
        
        if self.isScanningBeforeBackground {
          self.isScanningBeforeBackground = false
          for (scanId, params) in self.scanParams {
            let autoResolve = self.scanConfigs[scanId] ?? true
            
            let browser = NetServiceBrowser()
            browser.delegate = self.delegateCoordinator
            self.browsers[scanId] = browser
            browser.searchForServices(ofType: params.type, inDomain: params.domain)
          }
        }
      }
    }

    OnDestroy { [weak self] in
      guard let self = self else { return }
      
      let cleanup = {
        // Stop all active browsers
        for browser in self.browsers.values {
          browser.stop()
        }
        self.browsers.removeAll()
        self.scanConfigs.removeAll()
        self.scanParams.removeAll()
        
        // Clean up resolvers
        for resolvers in self.activeResolvers.values {
          for svc in resolvers {
            svc.delegate = nil
            svc.stop()
          }
        }
        self.activeResolvers.removeAll()
        self.serviceScanIds.removeAll()
        
        // Reject all outstanding manual resolutions safely to prevent microtask memory leaks in JS
        for (svc, promise) in self.manualResolvers {
          promise.reject("ERR_ZEROCONF_DESTROYED", "Module was destroyed before service could be resolved")
          svc.delegate = nil
          svc.stop()
        }
        self.manualResolvers.removeAll()
        
        // Stop and unpublish all published services
        for pubSvc in self.publishedServices.values {
          pubSvc.unpublish()
        }
        self.publishedServices.removeAll()
        self.originalToResolvedKeys.removeAll()
        
        // Stop all pending publish handshakes and reject their promises
        for pubSvc in self.pendingPublishServices.values {
          pubSvc.pendingPromise?.reject("ERR_ZEROCONF_DESTROYED", "Module was destroyed before publication completed")
          pubSvc.unpublish()
        }
        self.pendingPublishServices.removeAll()
      }
      
      BonjourRunLoop.shared.execute {
        cleanup()
      }
    }
  }

  internal func removePublishedService(_ service: PublishedService) {
    let resolvedKey = "\(service.name)|\(service.type)"
    publishedServices.removeValue(forKey: resolvedKey)
    if let originalKey = originalToResolvedKeys.first(where: { $0.value == resolvedKey })?.key {
      originalToResolvedKeys.removeValue(forKey: originalKey)
    }
  }
}

// ---------------------------------------------------------------------------
// NetServiceBrowserDelegate & NetServiceDelegate Mappings
// ---------------------------------------------------------------------------

extension ExpoZeroconfModule {
  
  // ----- NetServiceBrowserDelegate -----
  
  public func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    guard let scanId = browsers.first(where: { $0.value === browser })?.key else { return }
    
    sendEvent("onServiceFound", [
      "scanId": scanId,
      "service": [
        "name": service.name,
        "type": service.type,
        "domain": service.domain
      ]
    ])
    
    let autoResolve = scanConfigs[scanId] ?? true
    if !autoResolve {
      return
    }
    
    // Instantiate a resolver for this service
    let resolver = NetService(domain: service.domain, type: service.type, name: service.name)
    resolver.delegate = self.delegateCoordinator
    
    if activeResolvers[scanId] == nil {
      activeResolvers[scanId] = []
    }
    activeResolvers[scanId]?.append(resolver)
    serviceScanIds[resolver] = scanId
    
    // Schedule resolution on current thread (which is BonjourRunLoop)
    resolver.resolve(withTimeout: 5.0)
  }

  public func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    guard let scanId = browsers.first(where: { $0.value === browser })?.key else { return }
    
    sendEvent("onServiceRemoved", [
      "scanId": scanId,
      "name": service.name
    ])
  }

  public func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
    guard let scanId = browsers.first(where: { $0.value === browser })?.key else { return }
    let errorCode = errorDict[NetService.errorCode]?.intValue ?? -1
    
    sendEvent("onScanError", [
      "scanId": scanId,
      "error": "Failed to start service browser. Error code: \(errorCode)"
    ])
  }

  // ----- NetServiceDelegate (Resolving) -----
  
  public func netServiceDidResolveAddress(_ sender: NetService) {
    let addresses = parseAddresses(from: sender)
    let txt = parseTxtRecord(from: sender)
    
    let serviceData: [String: Any] = [
      "name": sender.name,
      "type": sender.type,
      "domain": sender.domain,
      "host": sender.hostName ?? "",
      "port": sender.port,
      "addresses": addresses,
      "txt": txt
    ]
    
    if let promise = self.manualResolvers.removeValue(forKey: sender) {
      promise.resolve(serviceData)
      sender.delegate = nil
      sender.stop()
      return
    }
    
    guard let scanId = serviceScanIds[sender] else { return }
    
    sendEvent("onServiceResolved", [
      "scanId": scanId,
      "service": serviceData
    ])
    
    cleanupResolver(sender)
  }

  public func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
    if let promise = self.manualResolvers.removeValue(forKey: sender) {
      let errorCode = errorDict[NetService.errorCode]?.intValue ?? -1
      promise.reject("ERR_ZEROCONF_RESOLVE_FAILED", "Failed to resolve service. Error code: \(errorCode)")
      sender.delegate = nil
      sender.stop()
      return
    }
    cleanupResolver(sender)
  }

  public func netService(_ sender: NetService, didUpdateTXTRecord data: Data) {
    let addresses = parseAddresses(from: sender)
    let txt = parseTxtRecord(from: sender)
    let serviceData: [String: Any] = [
      "name": sender.name,
      "type": sender.type,
      "domain": sender.domain,
      "host": sender.hostName ?? "",
      "port": sender.port,
      "addresses": addresses,
      "txt": txt
    ]
    
    if let scanId = serviceScanIds[sender] {
      sendEvent("onServiceResolved", [
        "scanId": scanId,
        "service": serviceData
      ])
    }
  }
  
  // ----- Helper Parsers -----

  private func cleanupResolver(_ service: NetService) {
    if let scanId = serviceScanIds.removeValue(forKey: service) {
      activeResolvers[scanId]?.removeAll(where: { $0 === service })
    }
    service.delegate = nil
    service.stop()
  }

  private func parseAddresses(from service: NetService) -> [String] {
    var ipAddresses = [String]()
    guard let addresses = service.addresses else { return ipAddresses }
    
    for addressData in addresses {
      addressData.withUnsafeBytes { (pointer: UnsafeRawBufferPointer) in
        guard let sockaddr = pointer.baseAddress?.assumingMemoryBound(to: sockaddr.self) else { return }
        
        var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let family = Int32(sockaddr.pointee.sa_family)
        
        if family == AF_INET || family == AF_INET6 {
          let sockLen = socklen_t(addressData.count)
          if getnameinfo(sockaddr, sockLen, &hostname, socklen_t(hostname.count), nil, 0, NI_NUMERICHOST) == 0 {
            let ipStr = String(cString: hostname)
            if !ipStr.isEmpty {
              ipAddresses.append(ipStr)
            }
          }
        }
      }
    }
    return ipAddresses
  }

  private func parseTxtRecord(from service: NetService) -> [String: String] {
    var txtDict = [String: String]()
    guard let txtData = service.txtRecordData() else { return txtDict }
    
    let rawDict = NetService.dictionary(fromTXTRecord: txtData)
    for (key, valData) in rawDict {
      // Base64 encode the values to protect dynamic binary bytes and avoid P0 UTF-8 data loss!
      txtDict[key] = valData.base64EncodedString()
    }
    return txtDict
  }
}
