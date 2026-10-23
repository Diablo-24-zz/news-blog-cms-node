const { getPool, withTransaction } = require("../config/db");
const { writeAudit } = require("../utils/audit");
const { badRequest, conflict, notFound } = require("../utils/errors");
const { slugify } = require("../utils/slug");

async function uniqueCategorySlug(connection, value, currentId) {
  const base = slugify(value);
  let candidate = base;
  let suffix = 2;
  while (true) {
    const [rows] = await connection.query(
      "SELECT id FROM categories WHERE slug = ? AND (? IS NULL OR id <> ?) LIMIT 1",
      [candidate, currentId || null, currentId || null],
    );
    if (!rows.length) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}

async function listCategories() {
  const [rows] = await getPool().query(
    "SELECT id, name, slug FROM categories ORDER BY name ASC",
  );
  return rows;
}

async function createCategory(actor, input) {
  return withTransaction(async (connection) => {
    const slug = input.slug
      ? slugify(input.slug)
      : await uniqueCategorySlug(connection, input.name);
    const [result] = await connection.query(
      "INSERT INTO categories (name, slug) VALUES (?, ?)",
      [input.name.trim(), slug],
    );
    await writeAudit(connection, {
      userId: actor.id,
      action: "category_create",
      entity: "category",
      entityId: result.insertId,
    });
    const [rows] = await connection.query(
      "SELECT id, name, slug FROM categories WHERE id = ?",
      [result.insertId],
    );
    return rows[0];
  });
}

async function updateCategory(actor, categoryId, input) {
  return withTransaction(async (connection) => {
    const [existingRows] = await connection.query(
      "SELECT id, name, slug FROM categories WHERE id = ? FOR UPDATE",
      [categoryId],
    );
    if (!existingRows[0]) throw notFound("Category not found");
    const name = input.name ?? existingRows[0].name;
    const slug = input.slug
      ? slugify(input.slug)
      : input.name
        ? await uniqueCategorySlug(connection, input.name, categoryId)
        : existingRows[0].slug;
    await connection.query(
      "UPDATE categories SET name = ?, slug = ? WHERE id = ?",
      [name.trim(), slug, categoryId],
    );
    await writeAudit(connection, {
      userId: actor.id,
      action: "category_update",
      entity: "category",
      entityId: categoryId,
    });
    return { id: categoryId, name, slug };
  });
}

async function deleteCategory(actor, categoryId) {
  await withTransaction(async (connection) => {
    const [existingRows] = await connection.query(
      "SELECT id FROM categories WHERE id = ? FOR UPDATE",
      [categoryId],
    );
    if (!existingRows[0]) throw notFound("Category not found");
    const [posts] = await connection.query(
      "SELECT id FROM posts WHERE category_id = ? LIMIT 1",
      [categoryId],
    );
    if (posts.length) throw conflict("Category is in use by a post", "IN_USE");
    await connection.query("DELETE FROM categories WHERE id = ?", [categoryId]);
    await writeAudit(connection, {
      userId: actor.id,
      action: "category_delete",
      entity: "category",
      entityId: categoryId,
    });
  });
}

function validateCategoryId(categoryId) {
  if (!Number.isInteger(Number(categoryId)) || Number(categoryId) <= 0) {
    throw badRequest("Invalid category id");
  }
  return Number(categoryId);
}

module.exports = {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  validateCategoryId,
};
