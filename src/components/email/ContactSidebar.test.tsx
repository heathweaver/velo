import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ContactSidebar } from "./ContactSidebar";
import type { DbContact, ContactAttachment, SameDomainContact } from "@/services/db/contacts";

const mockContact: DbContact = {
  id: "c-1",
  email: "alice@company.com",
  display_name: "Alice Smith",
  avatar_url: null,
  frequency: 10,
  last_contacted_at: Date.now(),
  notes: "Important client",
};

vi.mock("@/services/db/contacts", () => ({
  getContactByEmail: vi.fn(() => Promise.resolve(null)),
  getContactStats: vi.fn(() =>
    Promise.resolve({ emailCount: 5, firstEmail: 1700000000000, lastEmail: 1700100000000 }),
  ),
  getRecentThreadsWithContact: vi.fn(() => Promise.resolve([])),
  upsertContact: vi.fn(() => Promise.resolve()),
  updateContact: vi.fn(() => Promise.resolve()),
  updateContactNotes: vi.fn(() => Promise.resolve()),
  getAttachmentsFromContact: vi.fn(() => Promise.resolve([])),
  getContactsFromSameDomain: vi.fn(() => Promise.resolve([])),
  getLatestAuthResult: vi.fn(() => Promise.resolve(null)),
}));

const mockGetFilters = vi.fn(() => Promise.resolve([] as unknown[]));
const mockInsertFilter = vi.fn(() => Promise.resolve("filter-1"));
const mockUpdateFilter = vi.fn(() => Promise.resolve());
const mockSetCategoryForSender = vi.fn(() => Promise.resolve(3));
const mockRunSearch = vi.fn(() => Promise.resolve());

vi.mock("@/services/db/filters", () => ({
  getFiltersForAccount: (...args: unknown[]) => mockGetFilters(...(args as [])),
  insertFilter: (...args: unknown[]) => mockInsertFilter(...(args as [])),
  updateFilter: (...args: unknown[]) => mockUpdateFilter(...(args as [])),
}));

vi.mock("@/services/db/threadCategories", () => ({
  setCategoryForSender: (...args: unknown[]) => mockSetCategoryForSender(...(args as [])),
}));

vi.mock("@/services/search/runSearch", () => ({
  runSearch: (...args: unknown[]) => mockRunSearch(...(args as [])),
}));

vi.mock("@/stores/categoryStore", () => ({
  useCategoryStore: (selector: (s: { categories: unknown[] }) => unknown) =>
    selector({
      categories: [
        { id: "Reads", name: "Reads", description: "Long-form I subscribed to", icon: null, sortOrder: 0, isEnabled: true, isDefault: false },
        { id: "Primary", name: "Primary", description: "", icon: null, sortOrder: 1, isEnabled: true, isDefault: true },
      ],
    }),
}));

vi.mock("@/services/db/notificationVips", () => ({
  isVipSender: vi.fn(() => Promise.resolve(false)),
  addVipSender: vi.fn(() => Promise.resolve()),
  removeVipSender: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/contacts/gravatar", () => ({
  fetchAndCacheGravatarUrl: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/services/db/threads", () => ({
  getThreadById: vi.fn(),
  getThreadLabelIds: vi.fn(),
}));

vi.mock("@/router/navigate", () => ({
  navigateToThread: vi.fn(),
}));

vi.mock("@/utils/fileTypeHelpers", () => ({
  formatFileSize: vi.fn((bytes: number) => `${bytes} B`),
  getFileIcon: vi.fn(() => "\u{1F4CE}"),
}));

// Import mocked modules to configure per-test
import {
  getContactByEmail,
  getAttachmentsFromContact,
  getContactsFromSameDomain,
  getLatestAuthResult,
} from "@/services/db/contacts";
import { isVipSender } from "@/services/db/notificationVips";

const defaultProps = {
  email: "alice@company.com",
  name: "Alice Smith",
  accountId: "acc-1",
  onClose: vi.fn(),
};

describe("ContactSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders quick action buttons (compose, copy, VIP)", async () => {
    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle("Send email")).toBeInTheDocument();
      expect(screen.getByTitle("Copy email")).toBeInTheDocument();
      expect(screen.getByTitle("Mark as VIP")).toBeInTheDocument();
    });
  });

  it("shows 'Add to Contacts' when contact does not exist", async () => {
    vi.mocked(getContactByEmail).mockResolvedValueOnce(null);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Add to Contacts")).toBeInTheDocument();
    });
  });

  it("shows 'Edit name' when contact exists", async () => {
    vi.mocked(getContactByEmail).mockResolvedValueOnce(mockContact);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Edit name")).toBeInTheDocument();
    });
  });

  it("renders Notes section toggle when contact exists", async () => {
    vi.mocked(getContactByEmail).mockResolvedValueOnce(mockContact);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Notes")).toBeInTheDocument();
    });

    // Notes textarea should not be visible initially
    expect(screen.queryByPlaceholderText("Add a note...")).not.toBeInTheDocument();

    // Click to expand
    fireEvent.click(screen.getByText("Notes"));

    expect(screen.getByPlaceholderText("Add a note...")).toBeInTheDocument();
  });

  it("renders attachments section when data present", async () => {
    const mockAttachments: ContactAttachment[] = [
      { filename: "report.pdf", mime_type: "application/pdf", size: 1024, date: 1700000000000 },
    ];
    vi.mocked(getAttachmentsFromContact).mockResolvedValueOnce(mockAttachments);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Shared Files")).toBeInTheDocument();
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
    });
  });

  it("renders same-domain contacts section when data present", async () => {
    const mockDomainContacts: SameDomainContact[] = [
      { email: "bob@company.com", display_name: "Bob Jones", avatar_url: null },
    ];
    vi.mocked(getContactsFromSameDomain).mockResolvedValueOnce(mockDomainContacts);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Bob Jones")).toBeInTheDocument();
      expect(screen.getByText("bob@company.com")).toBeInTheDocument();
    });
  });

  it("renders AuthBadge next to name when auth results present", async () => {
    const authJson = JSON.stringify({
      spf: { result: "pass", detail: null },
      dkim: { result: "pass", detail: null },
      dmarc: { result: "pass", detail: null },
      aggregate: "pass",
    });
    vi.mocked(getLatestAuthResult).mockResolvedValueOnce(authJson);

    const { container } = render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      const badge = container.querySelector("[aria-label='Authentication passed']");
      expect(badge).toBeInTheDocument();
    });
  });

  it("shows VIP star as filled when sender is VIP", async () => {
    vi.mocked(isVipSender).mockResolvedValueOnce(true);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTitle("Remove VIP")).toBeInTheDocument();
    });
  });

  it("does not show Notes section when contact does not exist", async () => {
    vi.mocked(getContactByEmail).mockResolvedValueOnce(null);

    render(<ContactSidebar {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Add to Contacts")).toBeInTheDocument();
    });

    expect(screen.queryByText("Notes")).not.toBeInTheDocument();
  });

  describe("category assignment", () => {
    it("writes a rule and files the mail already received", async () => {
      // Both halves matter: the rule is what keeps the classifier from
      // re-deciding this sender, and the backfill is what makes the click
      // visibly do something to mail that is already there.
      render(<ContactSidebar {...defaultProps} />);

      fireEvent.click(await screen.findByRole("button", { name: /Reads/ }));

      await waitFor(() => {
        expect(mockInsertFilter).toHaveBeenCalledWith(
          expect.objectContaining({
            criteria: { from: "alice@company.com" },
            actions: { setCategory: "Reads" },
          }),
        );
      });
      expect(mockSetCategoryForSender).toHaveBeenCalledWith("acc-1", "alice@company.com", "Reads");
    });

    it("updates the existing rule rather than adding a second one", async () => {
      // Two rules matching the same sender would leave the winner up to
      // ordering, so re-picking a category has to edit the rule in place.
      mockGetFilters.mockResolvedValue([
        {
          id: "filter-existing",
          criteria_json: JSON.stringify({ from: "alice@company.com" }),
          actions_json: JSON.stringify({ setCategory: "Primary", archive: true }),
        },
      ]);

      render(<ContactSidebar {...defaultProps} />);

      fireEvent.click(await screen.findByRole("button", { name: /Reads/ }));

      await waitFor(() => {
        expect(mockUpdateFilter).toHaveBeenCalledWith("filter-existing", {
          actions: { setCategory: "Reads", archive: true },
        });
      });
      expect(mockInsertFilter).not.toHaveBeenCalled();
    });

    it("hands a from: query to the search bar for bulk actions", async () => {
      render(<ContactSidebar {...defaultProps} />);

      fireEvent.click(await screen.findByRole("button", { name: /Search all mail/ }));

      expect(mockRunSearch).toHaveBeenCalledWith("from:alice@company.com", "acc-1");
    });
  });
});
