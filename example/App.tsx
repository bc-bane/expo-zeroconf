import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  SafeAreaView,
  LayoutAnimation,
  Platform,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import {
  scanStream,
  publishService,
  PublishedService,
  ZeroconfService,
  isAvailable,
} from "expo-zeroconf";

export default function App() {
  const [serviceType, setServiceType] = useState("http");
  const [scanning, setScanning] = useState(false);
  const [resolvedServices, setResolvedServices] = useState<ZeroconfService[]>([]);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Active publishing states
  const [publishedService, setPublishedService] = useState<PublishedService | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [pubName, setPubName] = useState("Expo Test Node");
  const [pubPort, setPubPort] = useState("9999");

  // Keep a reference to the active stream so we can cancel it
  const activeStreamRef = useRef<AsyncGenerator<ZeroconfService, void, undefined> | null>(null);

  // Stop scanning helper
  const stopScanning = async () => {
    if (activeStreamRef.current) {
      await activeStreamRef.current.return(undefined);
      activeStreamRef.current = null;
    }
    setScanning(false);
  };

  // Start scanning progressive generator
  const startScanning = async () => {
    if (scanning) {
      await stopScanning();
    }

    setResolvedServices([]);
    setScanning(true);
    setExpandedCard(null);

    const stream = scanStream(serviceType, { timeoutMs: 10000 });
    activeStreamRef.current = stream;

    try {
      for await (const service of stream) {
        setResolvedServices((prev) => {
          // Deduplicate by name
          const exists = prev.some((s) => s.name === service.name);
          if (exists) return prev;
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          return [...prev, service];
        });
      }
    } catch (error) {
      console.error("Scan error:", error);
    } finally {
      setScanning(false);
      activeStreamRef.current = null;
    }
  };

  // Handle service registration / publishing
  const handlePublishToggle = async () => {
    if (publishedService) {
      // Unpublish
      try {
        publishedService.unpublish();
        setPublishedService(null);
      } catch (err) {
        console.error("Failed to unpublish:", err);
      }
    } else {
      // Publish
      setPublishing(true);
      const parsedPort = parseInt(pubPort, 10);
      try {
        const pub = await publishService({
          name: pubName,
          type: serviceType, // Dynamically use the scan/publish type entered in the input!
          port: isNaN(parsedPort) ? 9999 : parsedPort,
          txt: {
            sdk: "expo-56",
            engine: "JSI",
            framework: "new-arch",
          },
        });
        setPublishedService(pub);
      } catch (err) {
        console.error("Failed to publish service:", err);
      } finally {
        setPublishing(false);
      }
    }
  };

  // Clean up references on unmount
  useEffect(() => {
    return () => {
      stopScanning();
      if (publishedService) {
        try {
          publishedService.unpublish();
        } catch (_: any) {}
      }
    };
  }, [publishedService]);

  const toggleExpandCard = (name: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedCard(expandedCard === name ? null : name);
  };

  const renderServiceCard = ({ item }: { item: ZeroconfService }) => {
    const isExpanded = expandedCard === item.name;
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => toggleExpandCard(item.name)}
        style={styles.card}
      >
        <View style={styles.cardHeader}>
          <View style={styles.cardHeadlineWrap}>
            <Text style={styles.cardName}>{item.name}</Text>
            <Text style={styles.cardType}>{item.type}</Text>
          </View>
          <Text style={styles.cardPort}>Port: {item.port ?? "N/A"}</Text>
        </View>

        {isExpanded && (
          <View style={styles.cardDetails}>
            <View style={styles.divider} />
            
            <Text style={styles.detailTitle}>Host Address</Text>
            <Text style={styles.detailValue}>{item.host || "Unknown Hostname"}</Text>

            <Text style={styles.detailTitle}>IP Addresses</Text>
            {item.addresses && item.addresses.length > 0 ? (
              item.addresses.map((addr, index) => (
                <Text key={index} style={styles.detailValue}>
                  • {addr}
                </Text>
              ))
            ) : (
              <Text style={styles.detailValue}>None resolved</Text>
            )}

            <Text style={styles.detailTitle}>TXT Records</Text>
            {item.txt && Object.keys(item.txt).length > 0 ? (
              Object.entries(item.txt).map(([key, val]) => (
                <Text key={key} style={styles.detailValue}>
                  {key}: <Text style={styles.detailTxtValue}>{val}</Text>
                </Text>
              ))
            ) : (
              <Text style={styles.detailValue}>Empty TXT payload</Text>
            )}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>mDNS ZeroConf</Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {isAvailable ? "JSI Ready" : "Unlinked"}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Module Warning */}
        {!isAvailable && (
          <View style={styles.warningBox}>
            <Text style={styles.warningTitle}>⚠️ Native Module Missing</Text>
            <Text style={styles.warningText}>
              Ensure you compile this app inside a Development Build (expo run:ios or run:android) or standard vanilla build. Sockets do not operate inside Expo Go.
            </Text>
          </View>
        )}

        {/* Section: Scan */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Network Service Scanner</Text>
          <View style={styles.row}>
            <TextInput
              style={styles.input}
              placeholder="e.g. http, printer, airplay"
              placeholderTextColor="#666"
              value={serviceType}
              onChangeText={setServiceType}
              editable={!scanning}
            />
            <TouchableOpacity
              style={[
                styles.button,
                scanning ? styles.buttonStop : styles.buttonStart,
              ]}
              onPress={scanning ? stopScanning : startScanning}
            >
              {scanning ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Scan</Text>
              )}
            </TouchableOpacity>
          </View>

          {scanning && (
            <View style={styles.loaderWrap}>
              <Text style={styles.scanningText}>Discovering local services progressive stream...</Text>
            </View>
          )}

          <FlatList
            data={resolvedServices}
            keyExtractor={(item) => item.name}
            renderItem={renderServiceCard}
            scrollEnabled={false} // Managed by outer ScrollView
            ListEmptyComponent={
              !scanning ? (
                <View style={styles.emptyView}>
                  <Text style={styles.emptyText}>No services discovered yet. Press Scan.</Text>
                </View>
              ) : null
            }
          />
        </View>

        {/* Section: Advertise */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Local Service Publisher</Text>
          <Text style={styles.sectionDesc}>
            Broadcasts a Bonjour service over JSI. It will immediately show up on your other scanners as <Text style={styles.bold}>_expo-test._tcp</Text>.
          </Text>

          <View style={styles.advertiserBox}>
            {publishedService ? (
              <View style={styles.activeRegistrationCard}>
                <View style={styles.statusIndicator} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.activeRegName}>{pubName}</Text>
                  <Text style={styles.activeRegMeta}>Type: _expo-test._tcp • Port: {pubPort}</Text>
                </View>
              </View>
            ) : (
              <View style={styles.pubForm}>
                <TextInput
                  style={[styles.input, styles.pubInput]}
                  placeholder="Service Name"
                  placeholderTextColor="#666"
                  value={pubName}
                  onChangeText={setPubName}
                  editable={!publishedService}
                />
                <TextInput
                  style={[styles.input, styles.pubInput]}
                  placeholder="Port"
                  placeholderTextColor="#666"
                  value={pubPort}
                  onChangeText={setPubPort}
                  keyboardType="numeric"
                  editable={!publishedService}
                />
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.button,
                publishedService ? styles.buttonStop : styles.buttonStart,
                { marginTop: 12 },
              ]}
              onPress={handlePublishToggle}
              disabled={publishing}
            >
              {publishing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.buttonText}>
                  {publishedService ? "Unpublish Service" : "Publish Service"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#121214",
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 40,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1d1d21",
    ...Platform.select({
      ios: { paddingTop: 4 },
      android: { paddingTop: 36 }
    })
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: "#fff",
    letterSpacing: 0.5,
  },
  badge: {
    backgroundColor: "#3a2d54",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginLeft: 8,
  },
  badgeText: {
    color: "#d3c2eb",
    fontSize: 12,
    fontWeight: "700",
  },
  warningBox: {
    backgroundColor: "#291a1a",
    borderColor: "#542c2c",
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
  },
  warningTitle: {
    color: "#ff8080",
    fontWeight: "700",
    fontSize: 14,
    marginBottom: 4,
  },
  warningText: {
    color: "#d9b3b3",
    fontSize: 12,
    lineHeight: 16,
  },
  section: {
    marginBottom: 28,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 8,
  },
  sectionDesc: {
    fontSize: 13,
    color: "#aaa",
    lineHeight: 18,
    marginBottom: 12,
  },
  bold: {
    fontWeight: "700",
    color: "#ffc107",
  },
  row: {
    flexDirection: "row",
    marginBottom: 12,
  },
  input: {
    flex: 1,
    backgroundColor: "#1c1c1f",
    color: "#fff",
    height: 44,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  pubForm: {
    flexDirection: "row",
    gap: 8,
  },
  pubInput: {
    flex: 1,
  },
  button: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  buttonStart: {
    backgroundColor: "#5a3ca8",
  },
  buttonStop: {
    backgroundColor: "#a83c3c",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  loaderWrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
  scanningText: {
    color: "#5a3ca8",
    fontSize: 13,
    fontWeight: "600",
  },
  card: {
    backgroundColor: "#1c1c1f",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "between",
    alignItems: "center",
  },
  cardHeadlineWrap: {
    flex: 1,
  },
  cardName: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  cardType: {
    color: "#888",
    fontSize: 12,
    marginTop: 2,
  },
  cardPort: {
    color: "#9f83e3",
    fontWeight: "700",
    fontSize: 14,
  },
  cardDetails: {
    marginTop: 12,
  },
  divider: {
    height: 1,
    backgroundColor: "#2a2a2e",
    marginBottom: 10,
  },
  detailTitle: {
    fontSize: 11,
    color: "#666",
    fontWeight: "800",
    textTransform: "uppercase",
    marginBottom: 2,
  },
  detailValue: {
    fontSize: 14,
    color: "#ddd",
    marginBottom: 8,
    fontWeight: "500",
  },
  detailTxtValue: {
    color: "#00c853",
    fontWeight: "700",
  },
  emptyView: {
    paddingVertical: 32,
    alignItems: "center",
  },
  emptyText: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
  },
  advertiserBox: {
    backgroundColor: "#1c1c1f",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#2a2a2e",
  },
  activeRegistrationCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1d2b20",
    borderColor: "#275931",
    borderWidth: 1,
    padding: 12,
    borderRadius: 8,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#00c853",
    marginRight: 10,
  },
  activeRegName: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 15,
  },
  activeRegMeta: {
    color: "#a3cfae",
    fontSize: 12,
    marginTop: 2,
  },
});
