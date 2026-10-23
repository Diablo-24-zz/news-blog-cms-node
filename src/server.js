const { createApp } = require("./app");
const { loadConfig } = require("./config/env");

const config = loadConfig();
const app = createApp();
app.listen(config.PORT, () => {
  console.log(`News CMS listening on port ${config.PORT}`);
});
