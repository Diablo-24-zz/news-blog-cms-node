function getPagination(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(
    50,
    Math.max(1, Number.parseInt(query.limit, 10) || 10),
  );
  return { page, limit, offset: (page - 1) * limit };
}

function paginationData(page, limit, total) {
  return { page, limit, total, pages: Math.ceil(total / limit) };
}

module.exports = { getPagination, paginationData };
