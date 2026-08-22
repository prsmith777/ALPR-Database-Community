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

const LIVE_REFRESH_INTERVAL_MS = 5_000;
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

  // State to control if live updates are active (toggled by user)
  const [isLiveModeActive, setIsLiveModeActive] = useState(true);
  const eventSourceRef = useRef(null); // Ref to hold the EventSource instance
  const refreshTimingRef = useRef(null);
  const refreshAfterViewerCloseRef = useRef(false);
  const viewerWasOpenRef = useRef(false);

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
    const current = new URLSearchParams(params);
    // Exclude 'page' and 'pageSize' from being considered "filters" for live mode
    return Array.from(current.keys()).some(
      (key) =>
        key !== "page" &&
        key !== "pageSize" &&
        current.get(key) !== "" &&
        current.get(key) !== "all" &&
        current.get(key) !== null
    );
  }, [params]);

  // Effect to sync server-provided data with liveData when router.refresh() happens
  // This ensures that when liveMode is off (and filters are applied), or when
  // router.refresh() is explicitly called for mutations, the `liveData` state
  // gets the fresh dataset from the server.
  useEffect(() => {
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

  // The background visual-intelligence worker can update direction after the
  // plate row first appears. Refresh while live updates are enabled so Pending
  // becomes an assigned direction (or a genuine Unknown) without user action.
  useEffect(() => {
    if (!isLiveModeActive || isViewerOpen) return undefined;
    if (isFilterInteractionActive) return undefined;
    const timer = window.setInterval(
      () => {
        if (document.visibilityState === "visible") {
          requestLiveRefresh("live_poll");
        }
      },
      LIVE_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(timer);
  }, [
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

  // Effect to manage SSE connection and data merging
  // useEffect(() => {
  //   if (isLiveModeActive && !hasActiveFilters()) {
  //     // Connect only if live mode is active and no filters are applied
  //     if (!eventSourceRef.current) {
  //       eventSourceRef.current = new EventSource("/api/plate-reads");
  //       console.log("SSE: Attempting to connect...");

  //       eventSourceRef.current.onopen = () => {
  //         console.log("SSE: Connection established.");
  //       };

  //       // Event listener for new plate reads (SSE delivers the actual data)
  //       eventSourceRef.current.addEventListener("new-plate-read", (event) => {
  //         console.log("SSE: Received new plate read event:", event.data);
  //         try {
  //           const newPlateReads = JSON.parse(event.data); // This is an array of new plate objects

  //           setLiveData((prevData) => {
  //             // Ensure we are on the first page to receive live updates
  //             const currentPage = parseInt(params.get("page") || "1");
  //             if (currentPage !== 1) {
  //               // If not on the first page, just signal that there's new data.
  //               // A full refresh would be needed to see it, but we won't force it.
  //               console.log(
  //                 "SSE: New data arrived but not on first page, not updating live data directly."
  //               );
  //               return prevData;
  //             }

  //             const pageSize = parseInt(params.get("pageSize") || "25");

  //             // Merge new records, ensuring uniqueness and order
  //             const combinedData = [...newPlateReads, ...prevData];
  //             const uniqueData = Array.from(
  //               new Map(combinedData.map((item) => [item.id, item])).values()
  //             );

  //             // Sort by timestamp descending to keep newest at top
  //             uniqueData.sort(
  //               (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  //             );

  //             // Trim to page size
  //             return uniqueData.slice(0, pageSize);
  //           });

  //           setLiveTotal((prevTotal) => prevTotal + newPlateReads.length); // Increment total count
  //           // router.refresh(); // No need to trigger router.refresh() here, SSE updates liveData directly.
  //         } catch (e) {
  //           console.error(
  //             "SSE: Error parsing 'new-plate-read' event:",
  //             e,
  //             event.data
  //           );
  //         }
  //       });

  //       eventSourceRef.current.addEventListener("heartbeat", (event) => {
  //         // console.log("SSE: Heartbeat received:", event.data);
  //       });

  //       eventSourceRef.current.onerror = (error) => {
  //         console.error("SSE: EventSource error:", error);
  //         eventSourceRef.current.close();
  //         eventSourceRef.current = null;
  //         // Implement reconnect logic with exponential backoff if desired
  //       };
  //     }
  //   } else {
  //     // Disconnect SSE if live mode is off or filters are applied
  //     if (eventSourceRef.current) {
  //       eventSourceRef.current.close();
  //       eventSourceRef.current = null;
  //       console.log("SSE: Connection closed.");
  //     }
  //     // When live mode is off or filters are active, ensure we are displaying the server-provided data.
  //     // This is important because the 'data' prop from page.jsx would be the filtered/sorted result.
  //     if (liveData !== data || liveTotal !== total) {
  //       setLiveData(data);
  //       setLiveTotal(total);
  //     }
  //   }

  //   // Cleanup on component unmount
  //   return () => {
  //     if (eventSourceRef.current) {
  //       eventSourceRef.current.close();
  //       eventSourceRef.current = null;
  //       console.log("SSE: Connection cleaned up on unmount.");
  //     }
  //   };
  // }, [isLiveModeActive, hasActiveFilters, params, data, total]); // Re-run if live mode or params (filters) change

  // Helper for updating URL query params
  const createQueryString = useCallback(
    (updates) => {
      const current = new URLSearchParams(params);
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
      // When filters are updated, automatically disable live mode.
      setIsLiveModeActive(false);
      if (newParams.matchMode) {
        writePlateMatchPreference("recognition-feed", newParams.matchMode);
      }
      if (newParams.pageSize !== undefined) {
        writeTablePageSizePreference("live-feed", newParams.pageSize);
      }
      const queryString = createQueryString({ ...newParams, page: "1" });
      writeRecognitionFeedFilterPreference(
        recognitionFeedFilterPreferenceFromSearchParams(
          new URLSearchParams(queryString)
        )
      );
      router.push(`${pathname}?${queryString}`);
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
  const reviewStatusFilters = params.getAll("reviewStatus").filter(Boolean);
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
        page: parseInt(params.get("page") || "1"),
        pageSize: parseInt(
          params.get("pageSize") || String(preferredPageSize)
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
        readId: params.get("readId") || "",
        search: params.get("search") || "",
        matchMode: params.get("matchMode") || preferredMatchMode,
        tags: params.getAll("tag").filter((tag) => tag && tag !== "all"),
        dateRange: {
          from: params.get("timestampFrom") || params.get("dateFrom")
            ? new Date(params.get("timestampFrom") || params.get("dateFrom"))
            : null,
          to: params.get("timestampTo") || params.get("dateTo")
            ? new Date(params.get("timestampTo") || params.get("dateTo"))
            : null,
        },
        hourRange:
          params.get("hourFrom") && params.get("hourTo")
            ? {
                from: parseInt(params.get("hourFrom")),
                to: parseInt(params.get("hourTo")),
              }
            : null,
        cameraNames: params.getAll("camera").filter(Boolean),
        reviewStatuses: params.getAll("reviewStatus").filter(Boolean),
        directionLabels: params.getAll("direction").filter(Boolean),
        minimumSpeed: params.get("minimumSpeed") || "",
        maximumSpeed: params.get("maximumSpeed") || "",
        dashboardTimeFrame,
        dashboardMetric,
      }}
      sort={{
        field: params.get("sortField") || "timestamp",
        direction: params.get("sortDirection") || "desc",
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
