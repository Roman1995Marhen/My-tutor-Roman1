const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "code-tutor-reviews";
const REVIEW_PREFIX = "review-";
const APPROVED_INDEX_KEY = "approved-reviews";
const MAX_REVIEWS = 1000;
const ALLOWED_STATUSES = new Set(["pending", "approved", "hidden"]);

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}

function parseBody(event) {
  if (!event.body) {
    return {};
  }

  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;

  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find((header) => header.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : "";
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function isAuthorized(event) {
  const expectedPassword = process.env.REVIEWS_ADMIN_PASSWORD;
  const receivedPassword = getHeader(event, "x-admin-password");

  return Boolean(expectedPassword && receivedPassword && safeEqual(receivedPassword, expectedPassword));
}

async function listAllReviews(store) {
  const reviews = [];
  let cursor;

  do {
    const page = await store.list({ prefix: REVIEW_PREFIX, cursor });
    const blobs = page.blobs || [];

    const pageReviews = await Promise.all(
      blobs.map(async (blob) => {
        try {
          return await store.get(blob.key, { type: "json" });
        } catch (error) {
          return null;
        }
      })
    );

    reviews.push(...pageReviews.filter(Boolean));
    cursor = page.cursor;
  } while (cursor);

  return reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function toPublicReview(review) {
  return {
    id: review.id,
    name: review.name,
    course: review.course,
    rating: review.rating,
    comment: review.comment,
    createdAt: review.createdAt
  };
}

async function rebuildApprovedIndex(store) {
  const reviews = await listAllReviews(store);
  const approvedReviews = reviews
    .filter((review) => review.status === "approved")
    .slice(0, MAX_REVIEWS)
    .map(toPublicReview);

  await store.setJSON(APPROVED_INDEX_KEY, approvedReviews);
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  if (!process.env.REVIEWS_ADMIN_PASSWORD) {
    return json(500, { error: "Не задана переменная REVIEWS_ADMIN_PASSWORD в Netlify." });
  }

  if (!isAuthorized(event)) {
    return json(401, { error: "Неверный пароль администратора." });
  }

  const store = getStore(STORE_NAME);

  if (event.httpMethod === "GET") {
    const reviews = await listAllReviews(store);
    return json(200, { reviews });
  }

  const body = parseBody(event);
  if (!body) {
    return json(400, { error: "Некорректные данные." });
  }

  const id = String(body.id || "");
  if (!id.startsWith(REVIEW_PREFIX)) {
    return json(400, { error: "Некорректный id отзыва." });
  }

  const review = await store.get(id, { type: "json" });
  if (!review) {
    return json(404, { error: "Отзыв не найден." });
  }

  if (event.httpMethod === "PATCH") {
    const status = String(body.status || "");
    if (!ALLOWED_STATUSES.has(status)) {
      return json(400, { error: "Некорректный статус отзыва." });
    }

    const updatedReview = {
      ...review,
      status,
      updatedAt: new Date().toISOString()
    };

    if (status === "approved" && !updatedReview.approvedAt) {
      updatedReview.approvedAt = new Date().toISOString();
    }

    await store.setJSON(id, updatedReview);
    await rebuildApprovedIndex(store);
    return json(200, { ok: true, review: updatedReview });
  }

  if (event.httpMethod === "DELETE") {
    await store.delete(id);
    await rebuildApprovedIndex(store);
    return json(200, { ok: true });
  }

  return json(405, { error: "Метод не поддерживается." });
};