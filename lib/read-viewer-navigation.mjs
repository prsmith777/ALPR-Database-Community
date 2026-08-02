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

export function findNextUnconfirmedReadIndex({
  reads,
  selectedIndex,
  selectedPresent = true,
}) {
  if (
    !Array.isArray(reads) ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    (selectedPresent ? selectedIndex >= reads.length : selectedIndex > reads.length)
  ) {
    return -1;
  }

  const startIndex = selectedPresent ? selectedIndex + 1 : selectedIndex;
  for (let index = startIndex; index < reads.length; index += 1) {
    if (reads[index]?.validated !== true) return index;
  }
  return -1;
}

export function isConfirmNextOperationCurrent({
  activeToken,
  operationToken,
  selectedReadId,
  originReadId,
}) {
  return (
    activeToken !== null &&
    activeToken === operationToken &&
    selectedReadId !== null &&
    selectedReadId === originReadId
  );
}

export function resolveUnconfirmedPageTransition({
  pending,
  reads,
  page,
  pageSize,
  total,
  now,
  restoreTimeoutMs,
}) {
  if (!pending) return { kind: "complete" };

  if (now >= pending.deadlineAt) {
    if (pending.phase === "restore" || page <= pending.originPage) {
      return { kind: "complete", reason: "timeout" };
    }
    return {
      kind: "navigate",
      direction: "previous",
      pending: {
        ...pending,
        phase: "restore",
        targetPage: page - 1,
        deadlineAt: now + restoreTimeoutMs,
      },
    };
  }

  if (page !== pending.targetPage) return { kind: "wait" };

  if (pending.phase === "restore") {
    if (page <= pending.originPage) return { kind: "complete", reason: "restored" };
    return {
      kind: "navigate",
      direction: "previous",
      pending: { ...pending, targetPage: page - 1 },
    };
  }

  if (
    pending.phase === "await-filtered-removal" &&
    reads.some((read) => read.id === pending.originReadId)
  ) {
    return { kind: "wait" };
  }

  const candidateIndex = pending.phase === "await-filtered-removal"
    ? findNextUnconfirmedReadIndex({
        reads,
        selectedIndex: pending.originIndex,
        selectedPresent: false,
      })
    : reads.findIndex((read) => read?.validated !== true);
  if (candidateIndex >= 0) return { kind: "open", index: candidateIndex };

  if (page * pageSize < total) {
    return {
      kind: "navigate",
      direction: "next",
      pending: {
        ...pending,
        phase: "scan",
        targetPage: page + 1,
      },
    };
  }

  if (page > pending.originPage) {
    return {
      kind: "navigate",
      direction: "previous",
      pending: {
        ...pending,
        phase: "restore",
        targetPage: page - 1,
        deadlineAt: now + restoreTimeoutMs,
      },
    };
  }
  return { kind: "complete", reason: "no-match" };
}
