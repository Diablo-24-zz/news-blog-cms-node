const { createApp } = require("./app");
const { loadConfig } = require("./config/env");
const { buildSslOptions } = require("./config/db");
const { startPostViewCleanup } = require("./services/postService");

const config = loadConfig();
buildSslOptions(config);
const app = createApp();
app.listen(config.PORT, () => {
  console.log(`News CMS listening on port ${config.PORT}`);
  startPostViewCleanup();
});
