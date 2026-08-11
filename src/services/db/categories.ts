import { getDb } from "./connection";

/**
 * A user-editable inbox category.
 *
 * `description` is not decoration — it is the text handed to the AI classifier,
 * so it should read as an instruction about what belongs here. A category with
 * a vague description classifies badly.
 */
export interface DbCategory {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  sort_order: number;
  is_enabled: number;
  is_default: number;
}

export interface Category {
  id: string;
  name: string;
  description: string;
  icon: string | null;
  sortOrder: number;
  isEnabled: boolean;
  isDefault: boolean;
}

function toCategory(row: DbCategory): Category {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    sortOrder: row.sort_order,
    isEnabled: row.is_enabled === 1,
    isDefault: row.is_default === 1,
  };
}

export async function getAllCategories(): Promise<Category[]> {
  const db = await getDb();
  const rows = await db.select<DbCategory[]>(
    "SELECT * FROM categories ORDER BY sort_order, name",
  );
  return rows.map(toCategory);
}

/**
 * Turn a name into a stable id. Ids are referenced by thread_categories rows
 * and filter rules, so they never change once assigned — renaming a category
 * changes only its display name.
 */
function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "category";
}

export async function createCategory(input: {
  name: string;
  description: string;
  icon?: string | null;
}): Promise<string> {
  const db = await getDb();
  const existing = await getAllCategories();

  // Ids must be unique; a second "Reads" becomes "reads-2" rather than
  // colliding with the first and silently merging two categories of mail.
  const base = slugify(input.name);
  let id = base;
  let n = 2;
  while (existing.some((c) => c.id === id)) {
    id = `${base}-${n++}`;
  }

  const sortOrder = existing.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
  await db.execute(
    "INSERT INTO categories (id, name, description, icon, sort_order, is_enabled, is_default) VALUES ($1, $2, $3, $4, $5, 1, 0)",
    [id, input.name.trim(), input.description.trim(), input.icon ?? null, sortOrder],
  );
  return id;
}

export async function updateCategory(
  id: string,
  updates: { name?: string; description?: string; icon?: string | null; isEnabled?: boolean },
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (updates.name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(updates.name.trim());
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(updates.description.trim());
  }
  if (updates.icon !== undefined) {
    sets.push(`icon = $${i++}`);
    values.push(updates.icon);
  }
  if (updates.isEnabled !== undefined) {
    sets.push(`is_enabled = $${i++}`);
    values.push(updates.isEnabled ? 1 : 0);
  }
  if (sets.length === 0) return;

  values.push(id);
  await db.execute(`UPDATE categories SET ${sets.join(", ")} WHERE id = $${i}`, values);
}

/**
 * Delete a category and move everything filed under it to the default one.
 *
 * Leaving the rows pointing at a category that no longer exists would drop
 * those threads out of every category view without deleting the mail, which
 * reads as data loss.
 */
export async function deleteCategory(id: string): Promise<void> {
  const db = await getDb();
  const categories = await getAllCategories();
  const target = categories.find((c) => c.id === id);
  if (!target || target.isDefault) return;

  const fallback = categories.find((c) => c.isDefault && c.id !== id);
  if (fallback) {
    await db.execute(
      "UPDATE thread_categories SET category = $1 WHERE category = $2",
      [fallback.id, id],
    );
  } else {
    await db.execute("DELETE FROM thread_categories WHERE category = $1", [id]);
  }
  await db.execute("DELETE FROM categories WHERE id = $1", [id]);
}

/** Make one category the fallback, clearing the flag from whichever held it. */
export async function setDefaultCategory(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("UPDATE categories SET is_default = 0 WHERE is_default = 1");
  await db.execute("UPDATE categories SET is_default = 1, is_enabled = 1 WHERE id = $1", [id]);
}

export async function reorderCategories(orderedIds: string[]): Promise<void> {
  const db = await getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    await db.execute("UPDATE categories SET sort_order = $1 WHERE id = $2", [i, orderedIds[i]]);
  }
}
