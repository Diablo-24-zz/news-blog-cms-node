function slugify(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 260) || "post"
  );
}

async function uniqueSlug(connection, title, currentId) {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  while (true) {
    const [rows] = await connection.query(
      "SELECT id FROM posts WHERE slug = ? AND (? IS NULL OR id <> ?) LIMIT 1",
      [candidate, currentId || null, currentId || null],
    );
    if (rows.length === 0) return candidate;
    candidate = `${base}-${suffix}`.slice(0, 280);
    suffix += 1;
  }
}

module.exports = { slugify, uniqueSlug };
