package expo.modules.zeroconf

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume

// ---------------------------------------------------------------------------
// Published Service Shared Object
// ---------------------------------------------------------------------------

class PublishedService(
  val name: String,
  val type: String,
  private val serviceInfo: NsdServiceInfo,
  private val module: ExpoZeroconfModule
) : SharedObject() {
  fun unpublish() {
    module.removePublishedService(this, serviceInfo)
  }

  override fun sharedObjectDidRelease() {
    unpublish()
  }
}

// ---------------------------------------------------------------------------
// Options Record
// ---------------------------------------------------------------------------

class PublishOptions : Record {
  @Field var name: String = ""
  @Field var type: String = ""
  @Field var domain: String = "local."
  @Field var port: Int = 0
  @Field var txt: Map<String, String> = emptyMap()
}

// ---------------------------------------------------------------------------
// Thread-Safe Settled Promise Wrapper
// ---------------------------------------------------------------------------

class SafePromise(private val promise: expo.modules.kotlin.Promise) {
  private val settled = java.util.concurrent.atomic.AtomicBoolean(false)

  fun resolve(value: Any? = null) {
    if (settled.compareAndSet(false, true)) {
      promise.resolve(value)
    }
  }

  fun reject(code: String, message: String?, throwable: Throwable? = null) {
    if (settled.compareAndSet(false, true)) {
      promise.reject(code, message, throwable)
    }
  }
}

// ---------------------------------------------------------------------------
// Sequential Resolve Request Models
// ---------------------------------------------------------------------------

sealed class ResolveTask {
  data class Auto(val scanId: String, val serviceInfo: NsdServiceInfo) : ResolveTask()
  data class Manual(val serviceInfo: NsdServiceInfo, val promise: SafePromise) : ResolveTask()
}

sealed class ResolveResult {
  data class Success(val serviceInfo: NsdServiceInfo) : ResolveResult()
  data class Failed(val errorCode: Int) : ResolveResult()
  data class Error(val exception: Exception) : ResolveResult()
  object Cancelled : ResolveResult()
}

// ---------------------------------------------------------------------------
// Expo Zeroconf Native Module
// ---------------------------------------------------------------------------

class ExpoZeroconfModule : Module() {
  private val moduleScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val discoveryListeners = ConcurrentHashMap<String, NsdManager.DiscoveryListener>()
  private val registrationListeners = ConcurrentHashMap<String, NsdManager.RegistrationListener>()
  private val publishedServices = ConcurrentHashMap<String, PublishedService>()
  private val scanConfigs = ConcurrentHashMap<String, Boolean>()
  private val scanParams = ConcurrentHashMap<String, Triple<String, String, Boolean>>() // scanId: Triple(type, domain, autoResolve)
  private var isScanningBeforeBackground = false
  private val originalToResolvedKeys = ConcurrentHashMap<String, String>()
  
  private var multicastLock: WifiManager.MulticastLock? = null
  private val resolveChannel = Channel<ResolveTask>(Channel.UNLIMITED)
  private var resolveWorkerJob: Job? = null

  private fun emit(name: String, body: Map<String, Any?>) = sendEvent(name, body)

  override fun definition() = ModuleDefinition {
    Name("ExpoZeroconf")

    Events(
      "onServiceFound",
      "onServiceResolved",
      "onServiceRemoved",
      "onScanStopped",
      "onScanError"
    )

    // JSI Class mapping for PublishedService
    Class(PublishedService::class) {
      Constructor {
        PublishedService("", "", NsdServiceInfo(), this@ExpoZeroconfModule)
      }
      Property("name") { service: PublishedService ->
        service.name
      }
      Property("type") { service: PublishedService ->
        service.type
      }
      Function("unpublish") { service: PublishedService ->
        service.unpublish()
      }
    }

    Function("startScan") { scanId: String, type: String, domain: String, autoResolve: Boolean ->
      startScanInternal(scanId, type, domain, autoResolve)
    }

    Function("stopScan") { scanId: String ->
      stopScanInternal(scanId)
    }

    AsyncFunction("publish") { options: PublishOptions, promise: Promise ->
      val safePromise = SafePromise(promise)
      val context = appContext.reactContext
      val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
      if (nsdManager == null) {
        safePromise.reject("ERR_ZEROCONF_NSD_UNAVAILABLE", "NSD Manager is unavailable", null)
        return@AsyncFunction
      }

      val serviceInfo = NsdServiceInfo().apply {
        serviceName = options.name
        
        var cleanType = options.type
        if (cleanType.endsWith(".")) {
          cleanType = cleanType.substring(0, cleanType.length - 1)
        }
        serviceType = cleanType
        port = options.port
        
        // Load TXT record attributes with Base64 decoding for binary safety
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
          for ((key, value) in options.txt) {
            try {
              val decodedBytes = android.util.Base64.decode(value, android.util.Base64.NO_WRAP)
              setAttribute(key, String(decodedBytes, Charsets.UTF_8))
            } catch (_: Exception) {
              setAttribute(key, value)
            }
          }
        }
      }

      acquireMulticastLock()

      val listenerKey = "${options.name}|${serviceInfo.serviceType}"

      val registrationListener = object : NsdManager.RegistrationListener {
        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
          registrationListeners.remove(listenerKey)
          releaseMulticastLock()
          safePromise.reject("ERR_ZEROCONF_PUBLISH_FAILED", "Failed to register service. Code: $errorCode", null)
        }

        override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
          // Graceful ignore
        }

        override fun onServiceRegistered(registeredServiceInfo: NsdServiceInfo) {
          val actualName = registeredServiceInfo.serviceName ?: options.name
          val rawType = registeredServiceInfo.serviceType ?: serviceInfo.serviceType ?: options.type
          val actualType = rawType.trim('.')
          val key = "$actualName|$actualType"

          registrationListeners.remove(listenerKey)
          registrationListeners[key] = this
          originalToResolvedKeys[listenerKey] = key

          val pubSvc = PublishedService(
            actualName,
            actualType,
            registeredServiceInfo,
            this@ExpoZeroconfModule
          )
          publishedServices[key] = pubSvc
          safePromise.resolve(pubSvc)
        }

        override fun onServiceUnregistered(info: NsdServiceInfo) {
          // Graceful unregister
        }
      }

      registrationListeners[listenerKey] = registrationListener

      try {
        nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
      } catch (e: Exception) {
        registrationListeners.remove(listenerKey)
        releaseMulticastLock()
        safePromise.reject("ERR_ZEROCONF_PUBLISH_EXCEPTION", e.message ?: "Failed to register service", e)
      }
    }

    AsyncFunction("unpublishService") { name: String, type: String, promise: Promise ->
      val cleanType = type.trim('.')
      val originalKey = "$name|$cleanType"
      val resolvedKey = originalToResolvedKeys.remove(originalKey) ?: originalKey

      val pubSvc = publishedServices.remove(resolvedKey)
      if (pubSvc != null) {
        pubSvc.unpublish()
      } else {
        val listener = registrationListeners.remove(resolvedKey)
        val context = appContext.reactContext
        val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsdManager != null && listener != null) {
          try {
            nsdManager.unregisterService(listener)
          } catch (_: Exception) {}
        }
        releaseMulticastLock()
      }
      promise.resolve()
    }

    AsyncFunction("resolveService") { name: String, type: String, domain: String, promise: Promise ->
      val context = appContext.reactContext
      val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
      if (nsdManager == null) {
        promise.reject("ERR_ZEROCONF_NSD_UNAVAILABLE", "NSD Manager is unavailable", null)
        return@AsyncFunction
      }

      ensureResolveWorkerStarted()

      val serviceInfo = NsdServiceInfo().apply {
        serviceName = name
        var cleanType = type
        if (cleanType.endsWith(".")) {
          cleanType = cleanType.substring(0, cleanType.length - 1)
        }
        serviceType = cleanType
      }

      val safePromise = SafePromise(promise)
      resolveChannel.trySend(ResolveTask.Manual(serviceInfo, safePromise))
    }

    OnActivityEntersBackground {
      val context = appContext.reactContext
      val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
      
      if (discoveryListeners.isNotEmpty() && nsdManager != null) {
        isScanningBeforeBackground = true
        val activeScans = ArrayList(discoveryListeners.keys)
        for (scanId in activeScans) {
          val listener = discoveryListeners.remove(scanId)
          scanConfigs.remove(scanId)
          if (listener != null) {
            try {
              nsdManager.stopServiceDiscovery(listener)
            } catch (_: Exception) {}
            emit("onScanStopped", mapOf("scanId" to scanId))
          }
        }
      }
      releaseMulticastLock()
    }

    OnActivityEntersForeground {
      if (isScanningBeforeBackground) {
        isScanningBeforeBackground = false
        for ((scanId, params) in scanParams) {
          startScanInternal(scanId, params.first, params.second, params.third)
        }
      }
    }

    OnDestroy {
      moduleScope.cancel()
      
      val context = appContext.reactContext
      val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
      
      if (nsdManager != null) {
        for (listener in discoveryListeners.values) {
          try { nsdManager.stopServiceDiscovery(listener) } catch (_: Exception) {}
        }
        discoveryListeners.clear()
        scanConfigs.clear()
        scanParams.clear()

        for (listener in registrationListeners.values) {
          try { nsdManager.unregisterService(listener) } catch (_: Exception) {}
        }
        registrationListeners.clear()
        publishedServices.clear()
        originalToResolvedKeys.clear()
      }
      
      releaseMulticastLock()
    }
  }

  // ----- Internal Scanning Helpers -----

  private fun startScanInternal(scanId: String, type: String, domain: String, autoResolve: Boolean) {
    val context = appContext.reactContext
    val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
    if (nsdManager == null) {
      emit("onScanError", mapOf("scanId" to scanId, "error" to "NSD Service is unavailable"))
      return
    }

    scanConfigs[scanId] = autoResolve
    scanParams[scanId] = Triple(type, domain, autoResolve)

    ensureResolveWorkerStarted()
    acquireMulticastLock()

    val listener = object : NsdManager.DiscoveryListener {
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        discoveryListeners.remove(scanId)
        scanConfigs.remove(scanId)
        scanParams.remove(scanId)
        releaseMulticastLock()
        emit("onScanError", mapOf("scanId" to scanId, "error" to "Start discovery failed. Code: $errorCode"))
      }

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
      override fun onDiscoveryStarted(serviceType: String) {}
      override fun onDiscoveryStopped(serviceType: String) {
        emit("onScanStopped", mapOf("scanId" to scanId))
      }

      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        emit("onServiceFound", mapOf(
          "scanId" to scanId,
          "service" to mapOf(
            "name" to serviceInfo.serviceName,
            "type" to serviceInfo.serviceType,
            "domain" to "local."
          )
        ))

        val auto = scanConfigs[scanId] ?: true
        if (auto) {
          resolveChannel.trySend(ResolveTask.Auto(scanId, serviceInfo))
        }
      }

      override fun onServiceLost(serviceInfo: NsdServiceInfo) {
        emit("onServiceRemoved", mapOf(
          "scanId" to scanId,
          "name" to serviceInfo.serviceName
        ))
      }
    }

    var cleanType = type
    if (cleanType.endsWith(".")) {
      cleanType = cleanType.substring(0, cleanType.length - 1)
    }

    try {
      nsdManager.discoverServices(cleanType, NsdManager.PROTOCOL_DNS_SD, listener)
      discoveryListeners[scanId] = listener
    } catch (e: Exception) {
      scanConfigs.remove(scanId)
      scanParams.remove(scanId)
      releaseMulticastLock()
      emit("onScanError", mapOf("scanId" to scanId, "error" to (e.message ?: "Failed to start discovery")))
    }
  }

  private fun stopScanInternal(scanId: String) {
    val context = appContext.reactContext
    val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
    val listener = discoveryListeners.remove(scanId)
    scanConfigs.remove(scanId)
    scanParams.remove(scanId)
    
    if (nsdManager != null && listener != null) {
      try {
        nsdManager.stopServiceDiscovery(listener)
      } catch (_: Exception) {}
    }
    
    releaseMulticastLock()
  }

  // ----- Shared Object Disposal Callback -----
  
  internal fun removePublishedService(service: PublishedService, serviceInfo: NsdServiceInfo) {
    val context = appContext.reactContext ?: return
    val nsdManager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
    
    val cleanType = service.type.trim('.')
    val resolvedKey = "${service.name}|$cleanType"
    publishedServices.remove(resolvedKey)
    
    val entry = originalToResolvedKeys.entries.firstOrNull { it.value == resolvedKey }
    if (entry != null) {
      originalToResolvedKeys.remove(entry.key)
    }
    
    val listener = registrationListeners.remove(resolvedKey)
    if (listener != null) {
      try {
        nsdManager.unregisterService(listener)
      } catch (_: Exception) {}
    }
    
    releaseMulticastLock()
  }

  // ----- WiFi Multicast Lock Manager -----
  
  private fun acquireMulticastLock() {
    if (multicastLock == null) {
      val context = appContext.reactContext ?: return
      try {
        val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        multicastLock = wm?.createMulticastLock("expo-zeroconf-multicast-lock")?.apply {
          setReferenceCounted(false)
          acquire()
        }
      } catch (e: SecurityException) {
        Log.e("ExpoZeroconf", "Failed to acquire MulticastLock due to SecurityException", e)
      } catch (e: Exception) {
        Log.e("ExpoZeroconf", "Failed to create MulticastLock", e)
      }
    }
  }

  private fun releaseMulticastLock() {
    if (discoveryListeners.isEmpty() && publishedServices.isEmpty()) {
      try {
        multicastLock?.let {
          if (it.isHeld) it.release()
        }
      } catch (e: Exception) {
        Log.e("ExpoZeroconf", "Failed to release MulticastLock", e)
      }
      multicastLock = null
    }
  }

  // ----- Sequential Coroutine Resolving Engine -----
  
  private fun ensureResolveWorkerStarted() {
    if (resolveWorkerJob == null || resolveWorkerJob?.isCompleted == true) {
      resolveWorkerJob = moduleScope.launch {
        for (task in resolveChannel) {
          try {
            kotlinx.coroutines.withTimeout(3000) {
              resolveServiceWithRetry(task)
            }
          } catch (_: Exception) {
            kotlinx.coroutines.delay(300)
          }
        }
      }
    }
  }

  private suspend fun resolveServiceWithRetry(task: ResolveTask, maxRetries: Int = 3) {
    var attempt = 0
    while (attempt < maxRetries) {
      val result = suspendCancellableCoroutine<ResolveResult> { cont ->
        val context = appContext.reactContext
        val nsdManager = context?.getSystemService(Context.NSD_SERVICE) as? NsdManager
        if (nsdManager == null) {
          cont.resume(ResolveResult.Error(Exception("NSD Manager is null")))
          return@suspendCancellableCoroutine
        }

        val serviceInfo = when (task) {
          is ResolveTask.Auto -> task.serviceInfo
          is ResolveTask.Manual -> task.serviceInfo
        }

        if (task is ResolveTask.Auto && !discoveryListeners.containsKey(task.scanId)) {
          cont.resume(ResolveResult.Cancelled)
          return@suspendCancellableCoroutine
        }

        val listener = object : NsdManager.ResolveListener {
          override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
            if (cont.isActive) cont.resume(ResolveResult.Failed(errorCode))
          }

          override fun onServiceResolved(info: NsdServiceInfo) {
            if (cont.isActive) cont.resume(ResolveResult.Success(info))
          }
        }

        try {
          nsdManager.resolveService(serviceInfo, listener)
        } catch (e: Exception) {
          if (cont.isActive) cont.resume(ResolveResult.Error(e))
        }
      }

      when (result) {
        is ResolveResult.Success -> {
          val info = result.serviceInfo
          val addresses = mutableListOf<String>()
          info.host?.let { host ->
            val ip = host.hostAddress
            if (!ip.isNullOrEmpty()) {
              addresses.add(ip)
            }
          }

          val txtMap = mutableMapOf<String, String>()
          if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) {
            for ((key, valueBytes) in info.attributes) {
              try {
                // Base64 encode raw bytes for JSI transfer to avoid UTF-8 string data loss!
                txtMap[key] = if (valueBytes != null) android.util.Base64.encodeToString(valueBytes, android.util.Base64.NO_WRAP) else ""
              } catch (_: Exception) {}
            }
          }

          val serviceData = mapOf(
            "name" to info.serviceName,
            "type" to info.serviceType,
            "domain" to "local.",
            "host" to (info.host?.hostName ?: ""),
            "port" to info.port,
            "addresses" to addresses,
            "txt" to txtMap
          )

          when (task) {
            is ResolveTask.Auto -> {
              emit("onServiceResolved", mapOf(
                "scanId" to task.scanId,
                "service" to serviceData
              ))
            }
            is ResolveTask.Manual -> {
              task.promise.resolve(serviceData)
            }
          }
          return
        }
        is ResolveResult.Failed -> {
          if (result.errorCode == NsdManager.FAILURE_ALREADY_ACTIVE) {
            attempt++
            // Progressive delay cooling to allow system to recover
            kotlinx.coroutines.delay(200L * attempt)
          } else {
            if (task is ResolveTask.Manual) {
              task.promise.reject("ERR_ZEROCONF_RESOLVE_FAILED", "Resolve failed with code: ${result.errorCode}", null)
            }
            return
          }
        }
        is ResolveResult.Error -> {
          if (task is ResolveTask.Manual) {
            task.promise.reject("ERR_ZEROCONF_RESOLVE_EXCEPTION", result.exception.message ?: "Failed to resolve", result.exception)
          }
          return
        }
        is ResolveResult.Cancelled -> {
          return
        }
      }
    }

    if (task is ResolveTask.Manual) {
      task.promise.reject("ERR_ZEROCONF_RESOLVE_TIMEOUT", "Resolve failed after retries due to FAILURE_ALREADY_ACTIVE", null)
    }
  }
}
