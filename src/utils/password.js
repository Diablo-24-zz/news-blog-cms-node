const MIN_PASSWORD_CHARACTERS = 8;
const MAX_PASSWORD_BYTES = 72;

function isValidPasswordLength(password) {
  return (
    typeof password === "string" &&
    password.length >= MIN_PASSWORD_CHARACTERS &&
    Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES
  );
}

module.exports = { isValidPasswordLength, MAX_PASSWORD_BYTES };
