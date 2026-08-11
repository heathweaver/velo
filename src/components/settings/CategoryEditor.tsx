import { useState, useEffect } from "react";
import { Plus, Trash2, Check, Star } from "lucide-react";
import { useCategoryStore } from "@/stores/categoryStore";
import { CATEGORY_ICON_NAMES, getCategoryIcon } from "@/constants/categoryIcons";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

/**
 * Edit the inbox categories.
 *
 * The description field is the load-bearing one: it is handed verbatim to the
 * classifier, so it decides what actually lands in the category. The UI says so
 * rather than presenting it as a note to self.
 */
export function CategoryEditor() {
  const categories = useCategoryStore((s) => s.categories);
  const load = useCategoryStore((s) => s.load);
  const create = useCategoryStore((s) => s.create);
  const update = useCategoryStore((s) => s.update);
  const remove = useCategoryStore((s) => s.remove);
  const makeDefault = useCategoryStore((s) => s.makeDefault);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftIcon, setDraftIcon] = useState<string>("Tag");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!useCategoryStore.getState().loaded) load();
  }, [load]);

  const startEdit = (id: string) => {
    const category = categories.find((c) => c.id === id);
    if (!category) return;
    setAdding(false);
    setEditingId(id);
    setDraftName(category.name);
    setDraftDescription(category.description);
    setDraftIcon(category.icon ?? "Tag");
  };

  const startAdd = () => {
    setEditingId(null);
    setAdding(true);
    setDraftName("");
    setDraftDescription("");
    setDraftIcon("Tag");
  };

  const cancel = () => {
    setEditingId(null);
    setAdding(false);
  };

  const save = async () => {
    const name = draftName.trim();
    if (!name) return;
    if (adding) {
      await create({ name, description: draftDescription, icon: draftIcon });
    } else if (editingId) {
      await update(editingId, { name, description: draftDescription, icon: draftIcon });
    }
    cancel();
  };

  const editor = (
    <div className="space-y-2 p-3 bg-bg-tertiary rounded-md border border-border-primary">
      <TextField
        label="Name"
        size="sm"
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        placeholder="Reads"
      />
      <div>
        <label className="block text-xs text-text-secondary mb-1">
          What belongs here
        </label>
        <textarea
          value={draftDescription}
          onChange={(e) => setDraftDescription(e.target.value)}
          rows={3}
          placeholder="Newsletters and long-form writing I subscribed to and want to sit down and read, as opposed to anything that needs a reply."
          className="w-full text-xs bg-bg-primary border border-border-primary rounded-md px-2 py-1.5 text-text-secondary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent resize-y"
        />
        <p className="text-[0.625rem] text-text-tertiary mt-1">
          This wording is given to the AI when it sorts your mail. Describe what
          belongs here — and what does not — as if briefing an assistant.
        </p>
      </div>
      <div>
        <label className="block text-xs text-text-secondary mb-1">Icon</label>
        <div className="flex flex-wrap gap-1">
          {CATEGORY_ICON_NAMES.map((iconName) => {
            const Icon = getCategoryIcon(iconName);
            return (
              <button
                key={iconName}
                onClick={() => setDraftIcon(iconName)}
                title={iconName}
                className={`p-1.5 rounded-md border transition-colors ${
                  draftIcon === iconName
                    ? "bg-accent/10 border-accent/40 text-accent"
                    : "border-border-primary text-text-tertiary hover:text-text-primary"
                }`}
              >
                <Icon size={14} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button variant="primary" size="sm" onClick={save} disabled={!draftName.trim()}>
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      {categories.map((category) => {
        const Icon = getCategoryIcon(category.icon);
        if (editingId === category.id) return <div key={category.id}>{editor}</div>;

        return (
          <div
            key={category.id}
            className="flex items-start gap-2 px-3 py-2 rounded-md border border-border-primary"
          >
            <Icon size={14} className="text-text-tertiary shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-sm text-text-primary">{category.name}</span>
                {category.isDefault && (
                  <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                    default
                  </span>
                )}
                {!category.isEnabled && (
                  <span className="text-[0.625rem] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-tertiary">
                    hidden
                  </span>
                )}
              </div>
              <p className="text-xs text-text-tertiary mt-0.5">
                {category.description || "No description — the AI has nothing to go on."}
              </p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => startEdit(category.id)}
                className="text-xs text-text-tertiary hover:text-text-primary px-1.5 py-1"
              >
                Edit
              </button>
              {!category.isDefault && (
                <button
                  onClick={() => makeDefault(category.id)}
                  title="Make this the fallback category"
                  className="p-1 text-text-tertiary hover:text-accent"
                >
                  <Star size={12} />
                </button>
              )}
              <button
                onClick={() => update(category.id, { isEnabled: !category.isEnabled })}
                title={category.isEnabled ? "Hide from the sidebar and tabs" : "Show again"}
                className="p-1 text-text-tertiary hover:text-text-primary"
              >
                <Check size={12} className={category.isEnabled ? "text-success" : ""} />
              </button>
              {/* The default category has nowhere to move its mail to, so it
                  cannot be deleted — only renamed or repointed. */}
              {!category.isDefault && (
                confirmDelete === category.id ? (
                  <button
                    onClick={async () => {
                      await remove(category.id);
                      setConfirmDelete(null);
                    }}
                    className="text-[0.625rem] text-danger px-1.5 py-1"
                  >
                    Confirm
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(category.id)}
                    title="Delete — mail filed here moves to the default category"
                    className="p-1 text-text-tertiary hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                )
              )}
            </div>
          </div>
        );
      })}

      {adding ? (
        editor
      ) : (
        <button
          onClick={startAdd}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover transition-colors"
        >
          <Plus size={12} />
          Add category
        </button>
      )}
    </div>
  );
}
