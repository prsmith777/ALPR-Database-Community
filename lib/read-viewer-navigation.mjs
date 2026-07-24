export function resolveReadViewerNavigation({
  direction,
  selectedIndex,
  itemCount,
  page,
  pageSize,
  total,
}) {
  if (
    !["next", "previous"].includes(direction) ||
    !Number.isInteger(selectedIndex) ||
    !Number.isInteger(itemCount) ||
    itemCount < 1 ||
    selectedIndex < 0 ||
    selectedIndex >= itemCount
  ) {
    return { kind: "none" };
  }

  if (direction === "next") {
    if (selectedIndex < itemCount - 1) {
      return { kind: "item", index: selectedIndex + 1 };
    }

    if (page * pageSize < total) {
      return { kind: "page", page: page + 1, index: 0 };
    }

    return { kind: "none" };
  }

  if (selectedIndex > 0) {
    return { kind: "item", index: selectedIndex - 1 };
  }

  if (page > 1) {
    return { kind: "page", page: page - 1, index: -1 };
  }

  return { kind: "none" };
}
