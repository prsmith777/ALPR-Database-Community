"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import PlateTable from "./PlateTable";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  writePlateMatchPreference,
} from "@/lib/plate-match-preference.mjs";
import {
  writeTablePageSizePreference,
} from "@/lib/table-page-size-preference.mjs";
import {
  recognitionFeedFilterPreferenceFromSearchParams,
  writeRecognitionFeedFilterPreference,
} from "@/lib/recognition-feed-filter-preference.mjs";
import { scrollMainToTop } from "@/lib/page-scroll.mjs";
import {
  elapsedMilliseconds,
  recordLiveFeedPerformance,
} from "@/lib/live-feed-performance.mjs";
import {
  addKnownPlate,
  correctPlateRead,
  deletePlateRead,
  getPlateReviewHistory,
  previewPlateCorrection,
  reversePlateReview,
  reviewVehicleDirection,
  tagPlate,
  untagPlate,
  validatePlateRecord,
} from "@/app/actions";

const LIVE_REFRESH_TIMEOUT_MS = 15_000;

export default function PlateTableWrapper({
  data, // Initial data from server component (props from page.jsx)
  total, // Initial total from server component
  tags,
  cameras,
  directions,
  timeFormat,
  biHost,
  matchingSettings,
  dashboardTimeFrame,
  dashboardMetric,
  defaultMatchMode = "balanced",
  defaultPageSize = 25,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramsKey = params.toString();
  const preferredMatchMode =
    params.get("fuzzySearch") === "true" ? "balanced" : defaultMatchMode;
  const preferredPageSize = defaultPageSize;

  // State for live data, initially populated with server-rendered data
  // This will be updated by SSE.
  const [liveData, setLiveData] = useState(data);
  const [liveTotal, setLiveTotal] = useState(total);
  const [directionOverrides, setDirectionOverrides] = useState({});
  const [reviewOverrides, setReviewOverrides] = useState({});
  const [isViewerOpen, setIsViewerOpen] = useState(false);
  const [isFilterInteractionActive, setIsFilterInteractionActive] =
    useState(false);
  const [serverDataRevision, setServerDataRevision] = useState(0);
  const [optimisticQueryString, setOptimisticQueryString] = useState(paramsKey);

  // State to control if live updates are active (toggled by user)
  const [isLiveModeActive, setIsLiveModeActive] = useState(true);
  const eventSourceRef = useRef(null); // Ref to hold the EventSource instance
  const liveDataRef = useRef(data);
  const pendingLiveReadIdsRef = useRef(new Map());
  const liveDeltaInFlightRef = useRef(false);
  const flushLiveChangesRef = useRef(null);
  const refreshTimingRef = useRef(null);
  const refreshAfterViewerCloseRef = useRef(false);
  const viewerWasOpenRef = useRef(false);
  const pendingFilterQueryRef = useRef("");

  const requestLiveRefresh = useCallback((reason) => {
    const startedAt = performance.now();
    const active = refreshTimingRef.current;
    if (active && startedAt - active.startedAt < LIVE_REFRESH_TIMEOUT_MS) {
      return false;
    }
    if (active) {
      recordLiveFeedPerformance({
        metric: "feed_refresh",
        operation: active.reason,
        durationMs: elapsedMilliseconds(active.startedAt, startedAt),
        outcome: "timed_out",
      });
    }
    refreshTimingRef.current = {
      reason,
      startedAt,
    };
    router.refresh();
    return true;
  }, [router]);

  // Derived state to check if any filters are active
  const hasActiveFilters = useCallback(() => {
    const current = new URLSearchParams(paramsKey);
    // Exclude 'page' and 'pageSize' from being considered "filters" for live mode
    return Array.from(current.keys()).some(
      (key) =>
        key !== "page" &&
        key !== "pageSize" &&
        current.get(key) !== "" &&
        current.get(key) !== "all" &&
        current.get(key) !== null
    );
  }, [paramsKey]);

  // Effect to sync server-provided data with liveData when router.refresh() happens
  // This ensures that when liveMode is off (and filters are applied), or when
  // router.refresh() is explicitly called for mutations, the `liveData` state
  // gets the fresh dataset from the server.
  useEffect(() => {
    liveDataRef.current = data;
    setLiveData(data);
    setLiveTotal(total);
    setServerDataRevision((current) => current + 1);
    const timing = refreshTimingRef.current;
    if (timing) {
      recordLiveFeedPerformance({
        metric: "feed_refresh",
        operation: timing.reason,
        durationMs: elapsedMilliseconds(timing.startedAt, performance.now()),
        rowCount: data.length,
        total,
      });
      refreshTimingRef.current = null;
    }
  }, [data, total]);

  // Keep controls responsive while the Server Component is loading. Ignore
  // an older navigation response when a newer filter selection is pending.
  useEffect(() => {
    const pendingQuery = pendingFilterQueryRef.current;
    if (pendingQuery && pendingQuery !== paramsKey) return;
    pendingFilterQueryRef.current = "";
    setOptimisticQueryString(paramsKey);
  }, [paramsKey]);

  const mergeLiveRows = useCallback((rows, reasonsByReadId) => {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const existingIds = new Set(liveDataRef.current.map((row) => Number(row.id)));
    const insertableRows = rows.filter((row) =>
      existingIds.has(Number(row.id))
      || reasonsByReadId.get(Number(row.id)) === "ingested"
    );
    const insertedCount = insertableRows.filter((row) =>
      !existingIds.has(Number(row.id))
    ).length;
    if (insertableRows.length === 0) return;
    if (insertedCount > 0) {
      setLiveTotal((current) => current + insertedCount);
    }
    setLiveData((current) => {
      const byId = new Map(current.map((row) => [Number(row.id), row]));
      insertableRows.forEach((row) => byId.set(Number(row.id), row));
      const next = [...byId.values()]
        .sort((left, right) =>
          new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime()
          || Number(right.id) - Number(left.id)
        )
        .slice(0, Number.parseInt(
          new URLSearchParams(paramsKey).get("pageSize") || String(preferredPageSize),
          10
        ));
      liveDataRef.current = next;
      return next;
    });
    setServerDataRevision((current) => current + 1);
  }, [paramsKey, preferredPageSize]);

  const flushLiveChanges = useCallback(async () => {
    if (liveDeltaInFlightRef.current) return;
    const pendingChanges = [...pendingLiveReadIdsRef.current.entries()].slice(0, 25);
    if (pendingChanges.length === 0) return;
    pendingChanges.forEach(([readId]) => pendingLiveReadIdsRef.current.delete(readId));
    const readIds = pendingChanges.map(([readId]) => readId);
    const reasonsByReadId = new Map(pendingChanges);

    const current = new URLSearchParams(paramsKey);
    if (hasActiveFilters() || Number.parseInt(current.get("page") || "1", 10) !== 1) {
      pendingLiveReadIdsRef.current.clear();
      requestLiveRefresh("live_event");
      return;
    }

    liveDeltaInFlightRef.current = true;
    const startedAt = performance.now();
    try {
      const query = new URLSearchParams();
      readIds.slice(0, 25).forEach((readId) => query.append("readId", String(readId)));
      const response = await fetch(`/api/live-feed/changes?${query}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`Live Feed delta failed with ${response.status}`);
      const result = await response.json();
      mergeLiveRows(result.data, reasonsByReadId);
      recordLiveFeedPerformance({
        metric: "feed_delta",
        operation: "sse_change",
        durationMs: elapsedMilliseconds(startedAt, performance.now()),
        rowCount: result.data?.length || 0,
      });
    } catch {
      requestLiveRefresh("live_event_fallback");
    } finally {
      liveDeltaInFlightRef.current = false;
      if (pendingLiveReadIdsRef.current.size > 0) {
        window.setTimeout(() => void flushLiveChangesRef.current?.(), 0);
      }
    }
  }, [hasActiveFilters, mergeLiveRows, paramsKey, requestLiveRefresh]);
  flushLiveChangesRef.current = flushLiveChanges;

  useEffect(() => {
    if (!isLiveModeActive || isViewerOpen || isFilterInteractionActive) return undefined;

    const eventSource = new EventSource("/api/sse");
    eventSourceRef.current = eventSource;
    const handleChanges = (event) => {
      try {
        const message = JSON.parse(event.data);
        (message.readIds || []).forEach((readId) => {
          const value = Number.parseInt(String(readId), 10);
          if (Number.isSafeInteger(value) && value > 0) {
            pendingLiveReadIdsRef.current.set(value, message.reason || "changed");
          }
        });
        if (document.visibilityState === "visible") void flushLiveChanges();
      } catch {
        requestLiveRefresh("live_event_parse_fallback");
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void flushLiveChanges();
    };
    eventSource.addEventListener("plate-reads-changed", handleChanges);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      eventSource.removeEventListener("plate-reads-changed", handleChanges);
      eventSource.close();
      if (eventSourceRef.current === eventSource) eventSourceRef.current = null;
    };
  }, [
    flushLiveChanges,
    isFilterInteractionActive,
    isLiveModeActive,
    isViewerOpen,
    requestLiveRefresh,
  ]);

  useEffect(() => {
    setDirectionOverrides((current) => {
      let changed = false;
      const next = { ...current };
      data.forEach((plate) => {
        const override = current[plate.id];
        if (!override) return;
        if (
          plate.direction_status === override.direction_status &&
          plate.vehicle_orientation === override.vehicle_orientation &&
          plate.orientation_confidence === override.orientation_confidence &&
          plate.direction_label === override.direction_label
        ) {
          delete next[plate.id];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [data]);

  useEffect(() => {
    setReviewOverrides((current) => {
      let changed = false;
      const next = { ...current };
      data.forEach((plate) => {
        const override = current[plate.id];
        if (!override) return;
        if (
          plate.validated === override.validated &&
          plate.review_status === override.review_status &&
          Number(plate.review_revision || 0) >= Number(override.review_revision || 0) &&
          plate.plate_number === override.plate_number
        ) {
          delete next[plate.id];
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [data]);

  // Helper for updating URL query params
  const createQueryString = useCallback(
    (updates) => {
      const current = new URLSearchParams(
        pendingFilterQueryRef.current || params.toString()
      );
      Object.entries(updates).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          current.delete(key);
          value.filter(Boolean).forEach((item) => current.append(key, item));
          return;
        }
        if (value === null || value === undefined || value === "") {
          current.delete(key);
        } else {
          current.set(key, value);
        }
      });
      return current.toString();
    },
    [params]
  );

  const handleUpdateFilters = useCallback(
    (newParams) => {
      if (newParams.matchMode) {
        writePlateMatchPreference("recognition-feed", newParams.matchMode);
      }
      if (newParams.pageSize !== undefined) {
        writeTablePageSizePreference("live-feed", newParams.pageSize);
      }
      const queryString = createQueryString({ ...newParams, page: "1" });
      pendingFilterQueryRef.current = queryString;
      setOptimisticQueryString(queryString);
      writeRecognitionFeedFilterPreference(
        recognitionFeedFilterPreferenceFromSearchParams(
          new URLSearchParams(queryString)
        )
      );
      router.push(`${pathname}?${queryString}`, { scroll: false });
    },
    [createQueryString, pathname, router]
  );

  const handlePageChange = useCallback(
    (direction, { scrollToTop = true } = {}) => {
      // Paging means live mode should be off
      setIsLiveModeActive(false);
      const currentPage = parseInt(params.get("page") || "1");
      const pageSize = parseInt(
        params.get("pageSize") || String(preferredPageSize)
      );
      const newPage = direction === "next" ? currentPage + 1 : currentPage - 1;

      if (
        newPage < 1 ||
        (direction === "next" && currentPage * pageSize >= total)
      ) {
        return;
      }

      if (scrollToTop) scrollMainToTop();
      router.push(
        `${pathname}?${createQueryString({ page: newPage.toString() })}`,
        { scroll: false }
      );
    },
    [createQueryString, params, pathname, preferredPageSize, router, total]
  );

  // Most mutations refresh immediately. Plate confirmation is the exception:
  // it applies a local review override and defers the server refresh until the
  // viewer closes so Confirm and Next never races a full feed request.
  const handleAddTag = async (plateNumber, tagName) => {
    const formData = new FormData();
    formData.append("plateNumber", plateNumber);
    formData.append("tagName", tagName);
    const result = await tagPlate(formData);
    if (result.success) {
      router.refresh();
    }
    return result;
  };

  const handleRemoveTag = async (plateNumber, tagName) => {
    const formData = new FormData();
    formData.append("plateNumber", plateNumber);
    formData.append("tagName", tagName);
    const result = await untagPlate(formData);
    if (result.success) {
      router.refresh();
    }
    return result;
  };

  const handleAddKnownPlate = async (plateNumber, name, notes) => {
    const formData = new FormData();
    formData.append("plateNumber", plateNumber);
    formData.append("name", name);
    formData.append("notes", notes);
    const result = await addKnownPlate(formData);
    if (result.success) {
      router.refresh();
    }
    return result;
  };

  const handleDeleteRecord = async (id) => {
    const formData = new FormData();
    formData.append("id", id);
    const result = await deletePlateRead(formData);
    if (result.success) {
      router.refresh();
    }
    return result;
  };

  const handleCorrectPlate = async (formData) => {
    const result = await correctPlateRead(formData);
    if (result.success) {
      router.refresh();
    }
    return result;
  };

  const handleValidatePlate = async (id, value) => {
    const result = await validatePlateRecord(id, value);
    if (result.success) {
      setReviewOverrides((current) => ({
        ...current,
        [id]: {
          validated: value,
          review_status:
            result.data?.reviewStatus || (value ? "confirmed" : "unreviewed"),
          review_revision: Number(result.data?.reviewRevision || 0),
          plate_number: result.data?.effectivePlate,
        },
      }));
      if (isViewerOpen) {
        refreshAfterViewerCloseRef.current = true;
      } else {
        requestLiveRefresh("review_action");
      }
    }
    return result;
  };

  const handleViewerOpenChange = useCallback((open) => {
    const nextOpen = open === true;
    const wasOpen = viewerWasOpenRef.current;
    viewerWasOpenRef.current = nextOpen;
    setIsViewerOpen(nextOpen);
    if (
      wasOpen &&
      !nextOpen &&
      refreshAfterViewerCloseRef.current
    ) {
      refreshAfterViewerCloseRef.current = false;
      requestLiveRefresh("viewer_close");
    }
  }, [requestLiveRefresh]);

  const handleViewerDataRefresh = useCallback(() => {
    refreshAfterViewerCloseRef.current = false;
    requestLiveRefresh("confirm_next_filtered_boundary");
  }, [requestLiveRefresh]);

  const handlePreviewCorrection = async (formData) => {
    return await previewPlateCorrection(formData);
  };

  const handleReviewHistory = async (readId) => {
    return await getPlateReviewHistory(readId);
  };

  const handleReverseReview = async (formData) => {
    const result = await reversePlateReview(formData);
    if (result.success) router.refresh();
    return result;
  };

  const handleReviewDirection = async (readId, orientation) => {
    const result = await reviewVehicleDirection({ readId, orientation });
    if (result.success) {
      const observation = result.data?.observation;
      if (observation) {
        setDirectionOverrides((current) => ({
          ...current,
          [readId]: {
            direction_status: observation.status,
            vehicle_orientation: observation.orientation,
            orientation_confidence: observation.confidence,
            direction_label: observation.directionLabel,
          },
        }));
      }
      router.refresh();
    }
    return result;
  };

  const handleSort = useCallback(
    (field) => {
      // Sorting means live mode should be off
      setIsLiveModeActive(false);
      const currentSortField = params.get("sortField") || "";
      const currentSortDirection = params.get("sortDirection") || "desc";

      let newDirection = "asc";
      if (field === currentSortField) {
        newDirection = currentSortDirection === "desc" ? "asc" : "desc";
      }

      const queryString = createQueryString({
        sortField: field,
        sortDirection: newDirection,
      });
      writeRecognitionFeedFilterPreference(
        recognitionFeedFilterPreferenceFromSearchParams(
          new URLSearchParams(queryString)
        )
      );
      router.push(`${pathname}?${queryString}`);
    },
    [createQueryString, params, pathname, router]
  );

  // Determine which data to pass to PlateTable
  const baseDataToDisplay =
    hasActiveFilters() || !isLiveModeActive ? data : liveData;
  const dataWithOverrides = baseDataToDisplay.map((plate) => ({
    ...plate,
    ...(directionOverrides[plate.id] || {}),
    ...(reviewOverrides[plate.id] || {}),
  }));
  const displayedParams = new URLSearchParams(optimisticQueryString);
  const reviewStatusFilters = displayedParams
    .getAll("reviewStatus")
    .filter(Boolean);
  const dataToDisplay = reviewStatusFilters.length > 0
    ? dataWithOverrides.filter((plate) => reviewStatusFilters.includes(
        plate.review_status || (plate.validated ? "confirmed" : "unreviewed")
      ))
    : dataWithOverrides;
  const baseTotalToDisplay =
    hasActiveFilters() || !isLiveModeActive ? total : liveTotal;
  const totalToDisplay = Math.max(
    0,
    baseTotalToDisplay - (dataWithOverrides.length - dataToDisplay.length)
  );

  return (
    <PlateTable
      data={dataToDisplay}
      total={totalToDisplay}
      availableTags={[{ name: "untagged", color: "#6B7280" }, ...tags]}
      availableCameras={cameras}
      availableDirections={directions}
      timeFormat={timeFormat}
      biHost={biHost}
      pagination={{
        page: parseInt(displayedParams.get("page") || "1"),
        pageSize: parseInt(
          displayedParams.get("pageSize") || String(preferredPageSize)
        ),
        total: totalToDisplay,
        dataRevision: serverDataRevision,
        onNextPage: () => handlePageChange("next"),
        onPreviousPage: () => handlePageChange("prev"),
        onViewerPageChange: (direction) =>
          handlePageChange(direction, { scrollToTop: false }),
        onViewerDataRefresh: handleViewerDataRefresh,
      }}
      filters={{
        readId: displayedParams.get("readId") || "",
        search: displayedParams.get("search") || "",
        matchMode: displayedParams.get("matchMode") || preferredMatchMode,
        tags: displayedParams
          .getAll("tag")
          .filter((tag) => tag && tag !== "all"),
        dateRange: {
          from:
            displayedParams.get("timestampFrom") || displayedParams.get("dateFrom")
            ? new Date(
                displayedParams.get("timestampFrom") ||
                  displayedParams.get("dateFrom")
              )
            : null,
          to: displayedParams.get("timestampTo") || displayedParams.get("dateTo")
            ? new Date(
                displayedParams.get("timestampTo") ||
                  displayedParams.get("dateTo")
              )
            : null,
        },
        hourRange:
          displayedParams.get("hourFrom") && displayedParams.get("hourTo")
            ? {
                from: parseInt(displayedParams.get("hourFrom")),
                to: parseInt(displayedParams.get("hourTo")),
              }
            : null,
        cameraNames: displayedParams.getAll("camera").filter(Boolean),
        reviewStatuses: displayedParams.getAll("reviewStatus").filter(Boolean),
        directionLabels: displayedParams.getAll("direction").filter(Boolean),
        dashboardTimeFrame,
        dashboardMetric,
      }}
      sort={{
        field: displayedParams.get("sortField") || "timestamp",
        direction: displayedParams.get("sortDirection") || "desc",
      }}
      matchingSettings={matchingSettings}
      onSort={handleSort}
      onUpdateFilters={handleUpdateFilters}
      onAddTag={handleAddTag}
      onRemoveTag={handleRemoveTag}
      onAddKnownPlate={handleAddKnownPlate}
      onDeleteRecord={handleDeleteRecord}
      onCorrectPlate={handleCorrectPlate}
      onPreviewCorrection={handlePreviewCorrection}
      onReviewHistory={handleReviewHistory}
      onReverseReview={handleReverseReview}
      onReviewDirection={handleReviewDirection}
      onValidate={handleValidatePlate}
      onViewerOpenChange={handleViewerOpenChange}
      onFilterInteractionChange={setIsFilterInteractionActive}
      isLive={isLiveModeActive} // Pass the live mode state
      onLiveChange={setIsLiveModeActive} // Pass the setter for live mode
      loading={false} // Loading state is now more complex. For simplicity, we'll keep it false here.
      // A true loading state might be added with `useTransition` for server actions.
    />
  );
}
