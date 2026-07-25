export function resolveReadViewerNavigation({
  direction,
  selectedIndex,
  selectedPresent = true,
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
    (selectedPresent ? selectedIndex >= itemCount : selectedIndex > itemCount)
  ) {
    return { kind: "none" };
  }

  // A reviewed read can disappear from a status-filtered result set while its
  // viewer remains open. Its former index is then the insertion point for the
  // next visible read, so navigation must not skip that item.
  if (!selectedPresent) {
    if (direction === "next") {
      if (selectedIndex < itemCount) {
        return { kind: "item", index: selectedIndex };
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
