const { withInfoPlist, createRunOncePlugin } = require("@expo/config-plugins");

const pkg = require("./package.json");

function withZeroconfPermissions(config, props = {}) {
  const { serviceTypes = [], permissionMessage } = props;

  return withInfoPlist(config, (config) => {
    if (permissionMessage) {
      config.modResults.NSLocalNetworkUsageDescription = permissionMessage;
    } else if (!config.modResults.NSLocalNetworkUsageDescription) {
      config.modResults.NSLocalNetworkUsageDescription = 
        "This app requires local network access to discover and connect to nearby devices.";
    }

    if (serviceTypes.length > 0) {
      const formattedTypes = serviceTypes.map(type => {
        let clean = type.trim();
        // Inject leading underscore if not already present
        if (!clean.startsWith("_")) {
          clean = "_" + clean;
        }
        return clean;
      });
      
      const currentServices = config.modResults.NSBonjourServices || [];
      const combined = Array.from(new Set([...currentServices, ...formattedTypes]));
      config.modResults.NSBonjourServices = combined;
    }

    return config;
  });
}

module.exports = createRunOncePlugin(
  withZeroconfPermissions,
  pkg.name,
  pkg.version
);
