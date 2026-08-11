import {
  Inbox, Bell, Tag, Users, Newspaper, BookOpen, Bookmark, Archive,
  Receipt, FileText, Clock, Briefcase, ShoppingBag, Megaphone, Star,
  type LucideIcon,
} from "lucide-react";

/**
 * Icons a category may use.
 *
 * A fixed set rather than the whole lucide catalogue: the stored value is a
 * plain string in the database, so anything not in this map has to degrade to
 * a fallback, and offering hundreds of choices makes the picker unusable.
 */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  Inbox,
  Bell,
  Tag,
  Users,
  Newspaper,
  BookOpen,
  Bookmark,
  Archive,
  Receipt,
  FileText,
  Clock,
  Briefcase,
  ShoppingBag,
  Megaphone,
  Star,
};

export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_ICONS);

/** Resolve a stored icon name, falling back to a neutral tag. */
export function getCategoryIcon(name: string | null | undefined): LucideIcon {
  return (name && CATEGORY_ICONS[name]) || Tag;
}
