function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, "\\$&");
}

module.exports = { escapeLike };
