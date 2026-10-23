const $ = (selector, root = document) => root.querySelector(selector);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function showMessage(message, type = "error", target = $(".page")) {
  const old = $(".notice", target);
  if (old) old.remove();
  const box = node("div", message, `notice ${type}`);
  target.prepend(box);
  return box;
}

function showTemporaryPassword(password) {
  const target = $(".page");
  const old = $(".notice", target);
  if (old) old.remove();
  const box = node("div", undefined, "notice success");
  box.append(node("span", "Temporary password (copy it now): "));
  box.append(node("strong", password));
  const copy = node("button", "Copy");
  copy.className = "secondary";
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(password);
    copy.textContent = "Copied";
  });
  box.append(copy);
  target.prepend(box);
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Request failed");
    error.status = response.status;
    error.code = payload.error?.code;
    error.fields = payload.error?.fields;
    throw error;
  }
  return payload.data !== undefined ? payload : { data: payload };
}

function isoLocal(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

async function loadMe() {
  try {
    return (await api("/api/auth/me")).data;
  } catch {
    return null;
  }
}

async function setupNav() {
  const nav = $(".site-nav");
  if (!nav) return null;
  const me = await loadMe();
  nav.replaceChildren();
  const links = [["/index.html", "Blog"]];
  if (me) {
    links.push(["/dashboard.html", "Dashboard"]);
    if (["editor", "admin", "super_admin"].includes(me.role)) {
      links.push(["/review.html", "Review"]);
    }
    if (["admin", "super_admin"].includes(me.role)) {
      links.push(["/admin.html", "Admin"]);
    }
    if (me.role === "super_admin") links.push(["/audit.html", "Audit"]);
    links.push(["/change-password.html", "Password"]);
    links.forEach(([href, label]) => {
      const link = node("a", label);
      link.href = href;
      nav.append(link);
    });
    const logout = node("button", "Log out");
    logout.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      window.location.href = "/index.html";
    });
    nav.append(logout);
    return me;
  }
  const login = node("a", "Log in");
  login.href = "/login.html";
  nav.append(login);
  return null;
}

function protectPage(me) {
  if (!me) {
    window.location.href = "/login.html";
    return false;
  }
  if (
    me.must_change_password &&
    !window.location.pathname.endsWith("change-password.html")
  ) {
    window.location.href = "/change-password.html";
    return false;
  }
  return true;
}

function postCard(post) {
  const article = node("article", undefined, "card post-card");
  const title = node("h2");
  const link = node("a", post.title);
  link.href = `/post.html?slug=${encodeURIComponent(post.slug)}`;
  title.append(link);
  article.append(title);
  article.append(
    node(
      "p",
      `${post.author?.name || "Unknown author"} · ${isoLocal(post.published_at)} · ${post.views || 0} views`,
      "muted",
    ),
  );
  article.append(
    node(
      "p",
      post.content.length > 220
        ? `${post.content.slice(0, 220)}…`
        : post.content,
    ),
  );
  if (post.tags?.length) {
    article.append(node("p", `Tags: ${post.tags.join(", ")}`, "muted"));
  }
  return article;
}

function renderPagination(container, pagination, loadPage) {
  container.replaceChildren();
  if (!pagination || pagination.pages <= 1) return;
  const text = node("span", `Page ${pagination.page} of ${pagination.pages}`);
  const previous = node("button", "Previous");
  const next = node("button", "Next");
  previous.disabled = pagination.page <= 1;
  next.disabled = pagination.page >= pagination.pages;
  previous.addEventListener("click", () => loadPage(pagination.page - 1));
  next.addEventListener("click", () => loadPage(pagination.page + 1));
  container.append(previous, text, next);
}

async function initLogin() {
  const form = $("#login-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("button", form);
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      const result = await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      });
      window.location.href = result.data.must_change_password
        ? "/change-password.html"
        : "/dashboard.html";
    } catch (error) {
      showMessage(error.message, "error", form.parentElement);
    } finally {
      button.disabled = false;
    }
  });
}

async function initChangePassword(me) {
  if (!me) {
    window.location.href = "/login.html";
    return;
  }
  const form = $("#change-password-form");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      showMessage(
        "Password changed successfully.",
        "success",
        form.parentElement,
      );
      setTimeout(() => {
        window.location.href = "/dashboard.html";
      }, 600);
    } catch (error) {
      showMessage(error.message, "error", form.parentElement);
    }
  });
}

async function initPublicList() {
  const list = $("#public-posts");
  const pagination = $(".pagination");
  const form = $("#search-form");
  async function loadPage(page = 1) {
    list.replaceChildren(node("p", "Loading…", "muted"));
    const params = new URLSearchParams({ page, limit: 10 });
    const search = new FormData(form).get("search");
    if (search) params.set("search", search);
    try {
      const result = await api(`/api/posts/public?${params}`);
      list.replaceChildren(
        ...(result.data.length
          ? result.data.map(postCard)
          : [node("p", "No published posts yet.", "muted")]),
      );
      renderPagination(pagination, result.pagination, loadPage);
    } catch (error) {
      showMessage(error.message);
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    loadPage();
  });
  await loadPage();
}

async function initPublicPost() {
  const slug = new URLSearchParams(window.location.search).get("slug");
  const target = $("#post-detail");
  if (!slug) {
    showMessage("This post link is missing a slug.");
    return;
  }
  try {
    const post = (await api(`/api/posts/public/${encodeURIComponent(slug)}`))
      .data;
    target.replaceChildren();
    target.append(node("h1", post.title));
    target.append(
      node(
        "p",
        `${post.author.name} · ${isoLocal(post.published_at)} · ${post.views} views`,
        "muted",
      ),
    );
    target.append(node("p", post.content, "content"));
    if (post.tags?.length) {
      target.append(node("p", `Tags: ${post.tags.join(", ")}`, "muted"));
    }
  } catch (error) {
    showMessage(error.message, "error", target);
  }
}

async function initDashboard(me) {
  if (!protectPage(me)) return;
  const list = $("#my-posts");
  const form = $("#post-form");
  const saveButton = $('button[type="submit"]', form);
  const heading = $("h2", form);
  async function loadPosts() {
    const result = await api(`/api/posts?author=${me.id}&limit=50`);
    list.replaceChildren(
      ...(result.data.length
        ? result.data.map((post) => {
            const article = postCard(post);
            const actions = node("div", undefined, "actions");
            const mayEdit =
              post.author_id === me.id &&
              post.status !== "archived" &&
              (me.role !== "writer" ||
                ["draft", "rejected"].includes(post.status));
            if (mayEdit) {
              const edit = node("button", "Edit");
              edit.className = "secondary";
              edit.addEventListener("click", () => {
                form.elements.postId.value = post.id;
                form.elements.title.value = post.title;
                form.elements.content.value = post.content;
                form.elements.cover_image.value = post.cover_image || "";
                form.elements.tags.value = (post.tags || []).join(", ");
                heading.textContent = "Edit post";
                saveButton.textContent = "Save changes";
                form.scrollIntoView({ behavior: "smooth", block: "start" });
              });
              actions.append(edit);
            }
            const submit = node("button", "Submit for review");
            submit.disabled = post.status !== "draft";
            submit.addEventListener("click", async () => {
              await api(`/api/posts/${post.id}/submit`, { method: "PATCH" });
              await loadPosts();
            });
            actions.append(node("span", post.status, "status"), submit);
            article.append(actions);
            return article;
          })
        : [node("p", "You have no posts yet.", "muted")]),
    );
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(form));
      const postId = body.postId;
      delete body.postId;
      body.tags = body.tags
        ? body.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : [];
      await api(postId ? `/api/posts/${postId}` : "/api/posts", {
        method: postId ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      form.reset();
      heading.textContent = "New draft";
      saveButton.textContent = "Save draft";
      showMessage(postId ? "Post updated." : "Draft created.", "success");
      await loadPosts();
    } catch (error) {
      showMessage(error.message);
    }
  });
  await loadPosts();
}

async function initReview(me) {
  if (!protectPage(me)) return;
  const pendingList = $("#review-posts");
  const approvedList = $("#approved-posts");
  async function reload() {
    const [pending, approved] = await Promise.all([
      api("/api/posts?status=pending_review&limit=50"),
      api("/api/posts?status=approved&limit=50"),
    ]);
    pendingList.replaceChildren(
      ...(pending.data.length
        ? pending.data.map((post) => {
            const article = postCard(post);
            const actions = node("div", undefined, "actions");
            const approve = node("button", "Approve");
            const reject = node("button", "Reject", "danger");
            approve.disabled =
              post.author_id === me.id && me.role !== "super_admin";
            reject.disabled = approve.disabled;
            approve.addEventListener("click", async () => {
              await api(`/api/posts/${post.id}/approve`, { method: "PATCH" });
              await reload();
            });
            reject.addEventListener("click", () => {
              if ($(".review-rejection", article)) return;
              const rejectionForm = document.createElement("form");
              rejectionForm.className = "stack review-rejection";
              const commentLabel = node("label", "Reason for rejection");
              const comment = document.createElement("textarea");
              comment.required = true;
              comment.maxLength = 5000;
              comment.name = "review_comment";
              commentLabel.append(comment);
              const send = node("button", "Send rejection");
              rejectionForm.append(commentLabel, send);
              rejectionForm.addEventListener("submit", async (event) => {
                event.preventDefault();
                await api(`/api/posts/${post.id}/reject`, {
                  method: "PATCH",
                  body: JSON.stringify({ review_comment: comment.value }),
                });
                await reload();
              });
              article.append(rejectionForm);
            });
            actions.append(approve, reject);
            article.append(actions);
            return article;
          })
        : [node("p", "The review queue is empty.", "muted")]),
    );
    approvedList.replaceChildren(
      ...(approved.data.length
        ? approved.data.map((post) => {
            const article = postCard(post);
            const actions = node("div", undefined, "actions");
            const schedule = node("input");
            schedule.type = "datetime-local";
            schedule.setAttribute("aria-label", `Schedule ${post.title}`);
            const publish = node("button", "Publish");
            publish.addEventListener("click", async () => {
              const publishAt = schedule.value
                ? new Date(schedule.value).toISOString()
                : undefined;
              await api(`/api/posts/${post.id}/publish`, {
                method: "PATCH",
                body: JSON.stringify(
                  publishAt ? { publish_at: publishAt } : {},
                ),
              });
              await reload();
            });
            actions.append(schedule, publish);
            article.append(actions);
            return article;
          })
        : [node("p", "No approved stories are waiting to publish.", "muted")]),
    );
  }
  await reload();
}

function appendUserRow(table, user) {
  const row = table.insertRow();
  [
    user.name,
    user.email,
    user.role,
    user.is_active ? "Active" : "Inactive",
    user.must_change_password ? "Password change required" : "",
  ].forEach((value) => (row.insertCell().textContent = value));
}

async function initAdmin(me) {
  if (!protectPage(me)) return;
  const userForm = $("#user-form");
  const categoryForm = $("#category-form");
  const userBody = $("#users-table tbody");
  const categoryList = $("#categories");
  async function reload() {
    const users = (await api("/api/users?limit=50")).data;
    userBody.replaceChildren();
    users.forEach((user) => appendUserRow($("#users-table"), user));
    const categories = (await api("/api/categories")).data;
    categoryList.replaceChildren(
      ...(categories.length
        ? categories.map((category) =>
            node("li", `${category.name} (${category.slug})`),
          )
        : [node("li", "No categories")]),
    );
    const deleted = (await api("/api/posts?deleted=true&limit=50")).data;
    const deletedList = $("#deleted-posts");
    deletedList.replaceChildren(
      ...(deleted.length
        ? deleted.map((post) => {
            const item = node("li", `${post.title} `);
            const restore = node("button", "Restore");
            restore.addEventListener("click", async () => {
              await api(`/api/posts/${post.id}/restore`, { method: "POST" });
              await reload();
            });
            item.append(restore);
            return item;
          })
        : [node("li", "No deleted posts")]),
    );
  }
  userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await api("/api/users", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(userForm))),
      });
      userForm.reset();
      showTemporaryPassword(result.data.temporaryPassword);
      await reload();
    } catch (error) {
      showMessage(error.message);
    }
  });
  categoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/categories", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(new FormData(categoryForm))),
      });
      categoryForm.reset();
      await reload();
    } catch (error) {
      showMessage(error.message);
    }
  });
  await reload();
}

async function initAudit(me) {
  if (!protectPage(me)) return;
  const body = $("#audit-table tbody");
  const result = await api("/api/audit-logs?limit=50");
  body.replaceChildren(
    ...result.data.map((log) => {
      const row = document.createElement("tr");
      [
        isoLocal(log.created_at),
        log.action,
        log.entity,
        log.user_name || "System",
        JSON.stringify(log.details || {}),
      ].forEach((value) => (row.insertCell().textContent = value));
      return row;
    }),
  );
}

(async function boot() {
  const me = await setupNav();
  const page = document.body.dataset.page;
  if (page === "login") return initLogin();
  if (page === "change-password") return initChangePassword(me);
  if (page === "public-list") return initPublicList();
  if (page === "public-post") return initPublicPost();
  if (page === "dashboard") return initDashboard(me);
  if (page === "review") return initReview(me);
  if (page === "admin") return initAdmin(me);
  if (page === "audit") return initAudit(me);
})();
