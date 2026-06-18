import { Router } from "express";
import { db } from "@/db";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/api/categories", async (req, res) => {
  const { userId } = req.query;

  // =========================
  // 1. VALIDATION
  // =========================
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({
      error: "Missing or invalid userId",
    });
  }

  try {
    // =========================
    // 2. QUERY (LEFT JOIN)
    // =========================
    const result = await db.execute(sql`
      SELECT 
        c.id,
        c.name,
        c.slug,
        c.created_at,
        CASE 
          WHEN f.user_id IS NOT NULL THEN true 
          ELSE false 
        END AS "isFollowing"
      FROM categories c
      LEFT JOIN follows f
        ON f.category_id = c.id
        AND f.user_id = ${userId}
      ORDER BY c.name ASC
    `);

    // =========================
    // 3. RESPONSE
    // =========================
    return res.json({
      success: true,
      categories: result.rows,
    });
  } catch (err) {
    console.error("GET CATEGORIES ERROR:", err);
    return res.status(500).json({
      error: "Failed to fetch categories",
    });
  }
});

export default router;
