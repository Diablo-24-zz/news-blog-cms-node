const { getPool, withTransaction } = require("../config/db");
const { isAtLeast } = require("../utils/roles");
const { writeAudit } = require("../utils/audit");
const {
  badRequest,
  conflict,
  forbidden,
  notFound,
} = require("../utils/errors");
const { getPagination, paginationData } = require("../utils/pagination");
const { uniqueSlug } = require("../utils/slug");

const TRANSITIONS = Object.freeze({
  submit: { from: "draft", to: "pending_review" },
  approve: { from: "pending_review", to: "approved" },
  reject: { from: "pending_review", to: "rejected" },
  publish: { from: "approved", to: "published" },
  archive: { from: "published", to: "archived" },
});

const SORT_COLUMNS = Object.freeze({
  created_at: "p.created_at",
  updated_at: "p.updated_at",
  title: "p.title",
  views: "p.views",
  published_at: "p.published_at",
});

function isoUtc(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const normalized = String(value).includes("T")
    ? String(value)
    : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function publicPost(row, tags = []) {
  const post = { ...row };
  delete post.author_email;
  post.tags = tags;
  post.created_at = isoUtc(post.created_at);
  post.updated_at = isoUtc(post.updated_at);
  post.published_at = isoUtc(post.published_at);
  post.deleted_at = isoUtc(post.deleted_at);
  if (post.author_name !== undefined) {
    post.author = { id: post.author_id, name: post.author_name };
    delete post.author_name;
  }
  if (post.category_id !== undefined && post.category_id !== null) {
    post.category = {
      id: post.category_id,
      name: post.category_name,
      slug: post.category_slug,
    };
  }
  delete post.category_name;
  delete post.category_slug;
  return post;
}

function parsePublishAt(value) {
  if (value === undefined || value === null || value === "") return new Date();
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw badRequest("publish_at must include a timezone", {
      publish_at: "Use ISO 8601 with a timezone",
    });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest("publish_at is not a valid date", {
      publish_at: "Invalid ISO date",
    });
  }
  return date > new Date() ? date : new Date();
}

function normalizeTags(tags = []) {
  return [
    ...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean)),
  ];
}

async function selectPost(connection, id, forUpdate = false) {
  const [rows] = await connection.query(
    `SELECT p.id, p.author_id, p.category_id, p.title, p.slug, p.content, p.cover_image,
            p.status, p.reviewed_by, p.review_comment, p.published_at, p.views,
            p.deleted_at, p.created_at, p.updated_at,
            u.name AS author_name, u.email AS author_email,
            c.name AS category_name, c.slug AS category_slug
       FROM posts p
       JOIN users u ON u.id = p.author_id
       LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ?${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  if (!rows[0]) throw notFound("Post not found");
  return rows[0];
}

async function tagsForPost(postId, connection = getPool()) {
  const [rows] = await connection.query(
    `SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id
      WHERE pt.post_id = ? ORDER BY t.name ASC`,
    [postId],
  );
  return rows.map((row) => row.name);
}

function canView(actor, post, includeDeleted = false) {
  if (actor.role === "writer" && post.author_id !== actor.id) return false;
  if (!isAtLeast(actor.role, "admin") && post.deleted_at) return false;
  if (post.deleted_at && !includeDeleted && !isAtLeast(actor.role, "admin")) {
    return false;
  }
  return true;
}

async function findForActor(actor, postId, includeDeleted = false) {
  const post = await selectPost(getPool(), postId);
  if (!canView(actor, post, includeDeleted)) throw notFound("Post not found");
  return publicPost(post, await tagsForPost(post.id));
}

async function ensureCategory(connection, categoryId) {
  if (categoryId === null || categoryId === undefined) return;
  const [rows] = await connection.query(
    "SELECT id FROM categories WHERE id = ?",
    [categoryId],
  );
  if (!rows[0]) {
    throw badRequest("Category not found", { category_id: "Unknown category" });
  }
}

async function saveTags(connection, postId, tags) {
  if (tags === undefined) return;
  const normalized = normalizeTags(tags);
  if (normalized.length > 5) {
    throw badRequest("A post can have at most five tags", {
      tags: "Maximum five tags",
    });
  }
  await connection.query("DELETE FROM post_tags WHERE post_id = ?", [postId]);
  for (const tag of normalized) {
    await connection.query(
      "INSERT INTO tags (name) VALUES (?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
      [tag],
    );
    const [tagRows] = await connection.query(
      "SELECT id FROM tags WHERE name = ?",
      [tag],
    );
    await connection.query(
      "INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)",
      [postId, tagRows[0].id],
    );
  }
}

async function createPost(actor, input) {
  const result = await withTransaction(async (connection) => {
    await ensureCategory(connection, input.category_id);
    const slug = await uniqueSlug(connection, input.title);
    const [insert] = await connection.query(
      `INSERT INTO posts (author_id, category_id, title, slug, content, cover_image)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        actor.id,
        input.category_id ?? null,
        input.title.trim(),
        slug,
        input.content,
        input.cover_image || null,
      ],
    );
    await saveTags(connection, insert.insertId, input.tags);
    await writeAudit(connection, {
      userId: actor.id,
      action: "post_create",
      entity: "post",
      entityId: insert.insertId,
    });
    return selectPost(connection, insert.insertId);
  });
  return publicPost(result, await tagsForPost(result.id));
}

function assertCanEdit(actor, post) {
  if (post.deleted_at || post.status === "archived") {
    throw conflict("Archived or deleted posts cannot be edited");
  }
  if (actor.role === "writer") {
    if (post.author_id !== actor.id) throw notFound("Post not found");
    if (!["draft", "rejected"].includes(post.status)) {
      throw forbidden(
        "Writers can edit only their draft or rejected posts",
        "OWN_POST",
      );
    }
  } else if (post.author_id !== actor.id && !isAtLeast(actor.role, "editor")) {
    throw notFound("Post not found");
  }
}

async function updatePost(actor, postId, input) {
  const result = await withTransaction(async (connection) => {
    const current = await selectPost(connection, postId, true);
    assertCanEdit(actor, current);
    await ensureCategory(connection, input.category_id);

    const title = input.title ?? current.title;
    const content = input.content ?? current.content;
    const contentChanged =
      title !== current.title || content !== current.content;
    if (contentChanged) {
      await connection.query(
        "INSERT INTO post_revisions (post_id, title, content, edited_by) VALUES (?, ?, ?, ?)",
        [postId, current.title, current.content, actor.id],
      );
    }
    let slug = current.slug;
    if (title !== current.title && current.status !== "published") {
      slug = await uniqueSlug(connection, title, postId);
    }
    const nextStatus = current.status === "rejected" ? "draft" : current.status;
    const nextCategoryId = Object.prototype.hasOwnProperty.call(
      input,
      "category_id",
    )
      ? input.category_id
      : current.category_id;
    const nextCoverImage = Object.prototype.hasOwnProperty.call(
      input,
      "cover_image",
    )
      ? input.cover_image
      : current.cover_image;
    await connection.query(
      `UPDATE posts SET category_id = ?, title = ?, slug = ?, content = ?, cover_image = ?, status = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [
        nextCategoryId,
        title.trim(),
        slug,
        content,
        nextCoverImage || null,
        nextStatus,
        postId,
      ],
    );
    await saveTags(connection, postId, input.tags);
    await writeAudit(connection, {
      userId: actor.id,
      action: "post_edit",
      entity: "post",
      entityId: postId,
      details: { contentChanged },
    });
    return selectPost(connection, postId);
  });
  return publicPost(result, await tagsForPost(result.id));
}

async function listPosts(actor, query) {
  const { page, limit, offset } = getPagination(query);
  const conditions = [];
  const params = [];
  if (actor.role === "writer") {
    conditions.push("p.author_id = ?", "p.deleted_at IS NULL");
    params.push(actor.id);
  } else if (query.deleted === "true" || query.deleted === true) {
    if (!isAtLeast(actor.role, "admin")) {
      throw forbidden("Admin permission is required to view deleted posts");
    }
    conditions.push("p.deleted_at IS NOT NULL");
  } else {
    conditions.push("p.deleted_at IS NULL");
  }
  if (query.search) {
    conditions.push("p.title LIKE ?");
    params.push(`%${query.search}%`);
  }
  if (query.status) {
    conditions.push("p.status = ?");
    params.push(query.status);
  }
  if (query.category) {
    conditions.push("(c.slug = ? OR c.id = ?)");
    params.push(query.category, Number(query.category) || 0);
  }
  if (query.author) {
    conditions.push("p.author_id = ?");
    params.push(Number(query.author));
  }
  const sort = SORT_COLUMNS[query.sort] || SORT_COLUMNS.created_at;
  const direction =
    String(query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const select = `SELECT p.id, p.author_id, p.category_id, p.title, p.slug, p.content, p.cover_image,
      p.status, p.reviewed_by, p.review_comment, p.published_at, p.views, p.deleted_at,
      p.created_at, p.updated_at, u.name AS author_name, u.email AS author_email,
      c.name AS category_name, c.slug AS category_slug
    FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN categories c ON c.id = p.category_id ${where}`;
  const [rows] = await getPool().query(
    `${select} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS count FROM posts p LEFT JOIN categories c ON c.id = p.category_id ${where}`,
    params,
  );
  const data = [];
  for (const row of rows) data.push(publicPost(row, await tagsForPost(row.id)));
  return {
    data,
    pagination: paginationData(page, limit, Number(countRows[0].count)),
  };
}

async function transition(actor, postId, action, input = {}) {
  const transitionRule = TRANSITIONS[action];
  if (!transitionRule) throw badRequest("Unknown post transition");
  const result = await withTransaction(async (connection) => {
    const current = await selectPost(connection, postId, true);
    if (current.deleted_at) {
      throw conflict("Deleted posts cannot change workflow state");
    }
    if (action === "submit" && current.author_id !== actor.id) {
      throw forbidden("Only the author can submit this post", "OWN_POST");
    }
    if (
      ["approve", "reject"].includes(action) &&
      current.author_id === actor.id &&
      actor.role !== "super_admin"
    ) {
      throw forbidden("You cannot review your own post", "OWN_POST");
    }
    if (current.status !== transitionRule.from) {
      throw conflict(
        `Cannot ${action} a post in ${current.status} status`,
        "INVALID_TRANSITION",
      );
    }
    if (action === "reject" && !input.review_comment?.trim()) {
      throw badRequest("A rejection comment is required", {
        review_comment: "Required when rejecting",
      });
    }
    const fields = ["status = ?"];
    const values = [transitionRule.to];
    if (["approve", "reject"].includes(action)) {
      fields.push("reviewed_by = ?", "review_comment = ?");
      values.push(
        actor.id,
        action === "reject" ? input.review_comment.trim() : null,
      );
    }
    if (action === "publish") {
      fields.push("published_at = ?");
      values.push(parsePublishAt(input.publish_at));
    }
    values.push(postId, transitionRule.from);
    const [update] = await connection.query(
      `UPDATE posts SET ${fields.join(", ")} WHERE id = ? AND status = ? AND deleted_at IS NULL`,
      values,
    );
    if (update.affectedRows !== 1) {
      throw conflict(
        "The post changed before this transition completed",
        "INVALID_TRANSITION",
      );
    }
    await writeAudit(connection, {
      userId: actor.id,
      action: `post_${action}`,
      entity: "post",
      entityId: postId,
      details:
        action === "reject"
          ? { review_comment: input.review_comment.trim() }
          : {},
    });
    return selectPost(connection, postId);
  });
  return publicPost(result, await tagsForPost(result.id));
}

async function deletePost(actor, postId) {
  await withTransaction(async (connection) => {
    const post = await selectPost(connection, postId, true);
    if (post.deleted_at) throw conflict("Post is already deleted");
    if (
      !isAtLeast(actor.role, "admin") &&
      (post.author_id !== actor.id || post.status !== "draft")
    ) {
      throw notFound("Post not found");
    }
    const [result] = await connection.query(
      "UPDATE posts SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND deleted_at IS NULL",
      [postId],
    );
    if (result.affectedRows !== 1) throw conflict("Post was already deleted");
    await writeAudit(connection, {
      userId: actor.id,
      action: "post_delete",
      entity: "post",
      entityId: postId,
    });
  });
}

async function restorePost(actor, postId) {
  if (!isAtLeast(actor.role, "admin")) {
    throw forbidden("Admin permission is required");
  }
  const result = await withTransaction(async (connection) => {
    const post = await selectPost(connection, postId, true);
    if (!post.deleted_at) throw conflict("Post is not deleted");
    const [update] = await connection.query(
      "UPDATE posts SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
      [postId],
    );
    if (update.affectedRows !== 1) throw conflict("Post restore lost a race");
    await writeAudit(connection, {
      userId: actor.id,
      action: "post_restore",
      entity: "post",
      entityId: postId,
    });
    return selectPost(connection, postId);
  });
  return publicPost(result, await tagsForPost(result.id));
}

async function listRevisions(actor, postId) {
  const post = await selectPost(getPool(), postId);
  if (!canView(actor, post)) throw notFound("Post not found");
  const [rows] = await getPool().query(
    `SELECT r.id, r.post_id, r.title, r.content, r.edited_by, r.created_at, u.name AS editor_name
       FROM post_revisions r JOIN users u ON u.id = r.edited_by
      WHERE r.post_id = ? ORDER BY r.created_at DESC, r.id DESC`,
    [postId],
  );
  return rows.map((row) => ({
    ...row,
    created_at: isoUtc(row.created_at),
    editor: { id: row.edited_by, name: row.editor_name },
  }));
}

async function restoreRevision(actor, postId, revisionId) {
  if (!isAtLeast(actor.role, "editor")) {
    throw forbidden("Editor permission is required");
  }
  const result = await withTransaction(async (connection) => {
    const post = await selectPost(connection, postId, true);
    if (post.deleted_at || post.status === "archived") {
      throw conflict("This post cannot be edited");
    }
    const [revisionRows] = await connection.query(
      "SELECT id, title, content FROM post_revisions WHERE id = ? AND post_id = ?",
      [revisionId, postId],
    );
    if (!revisionRows[0]) throw notFound("Revision not found");
    await connection.query(
      "INSERT INTO post_revisions (post_id, title, content, edited_by) VALUES (?, ?, ?, ?)",
      [postId, post.title, post.content, actor.id],
    );
    let slug = post.slug;
    if (post.status !== "published" && revisionRows[0].title !== post.title) {
      slug = await uniqueSlug(connection, revisionRows[0].title, postId);
    }
    await connection.query(
      "UPDATE posts SET title = ?, slug = ?, content = ?, status = ? WHERE id = ? AND deleted_at IS NULL",
      [
        revisionRows[0].title,
        slug,
        revisionRows[0].content,
        post.status === "rejected" ? "draft" : post.status,
        postId,
      ],
    );
    await writeAudit(connection, {
      userId: actor.id,
      action: "post_revision_restore",
      entity: "post",
      entityId: postId,
      details: { revisionId },
    });
    return selectPost(connection, postId);
  });
  return publicPost(result, await tagsForPost(result.id));
}

function publicWhere(query) {
  const conditions = [
    "p.status = 'published'",
    "p.published_at <= UTC_TIMESTAMP()",
    "p.deleted_at IS NULL",
  ];
  const params = [];
  if (query.search) {
    conditions.push("p.title LIKE ?");
    params.push(`%${query.search}%`);
  }
  if (query.category) {
    conditions.push("(c.slug = ? OR c.id = ?)");
    params.push(query.category, Number(query.category) || 0);
  }
  if (query.tag) {
    conditions.push(
      "EXISTS (SELECT 1 FROM post_tags pt2 JOIN tags t2 ON t2.id = pt2.tag_id WHERE pt2.post_id = p.id AND t2.name = ?)",
    );
    params.push(query.tag.toLowerCase());
  }
  return { where: `WHERE ${conditions.join(" AND ")}`, params };
}

async function listPublic(query) {
  const { page, limit, offset } = getPagination(query);
  const { where, params } = publicWhere(query);
  const sort = SORT_COLUMNS[query.sort] || SORT_COLUMNS.published_at;
  const direction =
    String(query.direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const select = `SELECT p.id, p.author_id, p.category_id, p.title, p.slug, p.content, p.cover_image,
      p.status, p.published_at, p.views, p.created_at, p.updated_at,
      u.name AS author_name, c.name AS category_name, c.slug AS category_slug
    FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN categories c ON c.id = p.category_id ${where}`;
  const [rows] = await getPool().query(
    `${select} ORDER BY ${sort} ${direction} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const [countRows] = await getPool().query(
    `SELECT COUNT(*) AS count FROM posts p LEFT JOIN categories c ON c.id = p.category_id ${where}`,
    params,
  );
  const data = [];
  for (const row of rows) data.push(publicPost(row, await tagsForPost(row.id)));
  return {
    data,
    pagination: paginationData(page, limit, Number(countRows[0].count)),
  };
}

async function getPublicBySlug(slug) {
  const [update] = await getPool().query(
    `UPDATE posts SET views = views + 1
      WHERE slug = ? AND status = 'published' AND published_at <= UTC_TIMESTAMP() AND deleted_at IS NULL`,
    [slug],
  );
  if (update.affectedRows !== 1) throw notFound("Post not found");
  const [rows] = await getPool().query(
    `SELECT p.id, p.author_id, p.category_id, p.title, p.slug, p.content, p.cover_image,
            p.status, p.published_at, p.views, p.created_at, p.updated_at,
            u.name AS author_name, c.name AS category_name, c.slug AS category_slug
       FROM posts p JOIN users u ON u.id = p.author_id LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ? AND p.status = 'published' AND p.published_at <= UTC_TIMESTAMP() AND p.deleted_at IS NULL`,
    [slug],
  );
  return publicPost(rows[0], await tagsForPost(rows[0].id));
}

module.exports = {
  TRANSITIONS,
  createPost,
  updatePost,
  listPosts,
  findForActor,
  transition,
  deletePost,
  restorePost,
  listRevisions,
  restoreRevision,
  listPublic,
  getPublicBySlug,
};
