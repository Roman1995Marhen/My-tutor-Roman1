const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "code-tutor-reviews";
const REVIEW_PREFIX = "review-";
const ADMIN_PASSWORD = process.env.REVIEWS_ADMIN_PASSWORD;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, x-admin-password",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
    },
    body: JSON.stringify(payload)
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const body = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(body);
  } catch (error) {
    return null;
  }
}

function checkAuth(event) {
  const password = event.headers["x-admin-password"] || event.headers["X-Admin-Password"];
  if (!ADMIN_PASSWORD) {
    console.error("REVIEWS_ADMIN_PASSWORD environment variable is not set");
    return false;
  }
  return password === ADMIN_PASSWORD;
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeReview(input) {
  const name = cleanText(input.name, 80);
  const course = cleanText(input.course, 140);
  const comment = cleanText(input.comment, 1000);
  const rating = Number(input.rating);

  if (name.length < 2) return { error: "Укажите имя минимум из 2 символов." };
  if (!course) return { error: "Выберите проект обучения." };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: "Выберите оценку от 1 до 5." };
  if (comment.length < 10) return { error: "Напишите комментарий минимум из 10 символов." };
  return { name, course, rating, comment };
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
        } catch {
          return null;
        }
      })
    );
    reviews.push(...pageReviews.filter(Boolean));
    cursor = page.cursor;
  } while (cursor);
  return reviews.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

exports.handler = async function (event) {
  // 1. Обработка CORS
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  // ✅ 2. СОЗДАЕМ STORE СРАЗУ (вот это важно!)
  const store = getStore({
    name: STORE_NAME,
    createIfMissing: true // 👈 Автоматическое создание хранилища
  });

  // 3. POST запрос (публичная отправка, не требует пароля)
  if (event.httpMethod === "POST") {
    try {
      const body = parseBody(event);
      if (!body) return json(400, { error: "Некорректные данные формы." });

      if (body.botField || body["bot-field"]) {
        return json(200, { ok: true });
      }

      const normalized = normalizeReview(body);
      if (normalized.error) return json(400, { error: normalized.error });

      const existingReviews = await listAllReviews(store);
      if (existingReviews.length >= 1000) {
        return json(409, { error: "Достигнут лимит в 1000 отзывов." });
      }

      const id = `${REVIEW_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
      const review = {
        id,
        name: normalized.name,
        course: normalized.course,
        rating: normalized.rating,
        comment: normalized.comment,
        status: "pending",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await store.setJSON(id, review);
      return json(201, { ok: true, message: "Отзыв отправлен на модерацию." });
    } catch (error) {
      console.error("POST Error:", error);
      return json(500, { error: "Внутренняя ошибка сервера." });
    }
  }

  // 4. GET, PATCH, DELETE (требуют пароль)
  if (!checkAuth(event)) {
    return json(401, { error: "Неверный пароль администратора." });
  }

  try {
    // GET - получить все отзывы
    if (event.httpMethod === "GET") {
      const allReviews = await listAllReviews(store);
      return json(200, { reviews: allReviews });
    }

    // PATCH - обновить статус
    if (event.httpMethod === "PATCH") {
      const body = parseBody(event);
      if (!body || !body.id || !body.status) {
        return json(400, { error: "Не указан ID или статус." });
      }

      const reviewData = await store.get(body.id, { type: "json" });
      if (!reviewData) return json(404, { error: "Отзыв не найден." });

      reviewData.status = body.status;
      reviewData.updatedAt = new Date().toISOString();
      await store.setJSON(body.id, reviewData);

      return json(200, { success: true, review: reviewData });
    }

    // DELETE - удалить отзыв
    if (event.httpMethod === "DELETE") {
      const body = parseBody(event);
      if (!body || !body.id) {
        return json(400, { error: "Не указан ID отзыва." });
      }

      await store.delete(body.id);
      return json(200, { success: true });
    }

    return json(405, { error: "Метод не поддерживается." });
  } catch (error) {
    console.error("Admin Error:", error);
    return json(500, { error: error.message || "Внутренняя ошибка сервера." });
  }
};
