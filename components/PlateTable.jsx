"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import NextImage from "next/image";
import Link from "next/link";
import {
  Search,
  Filter,
  Tag,
  Plus,
  Trash2,
  X,
  HelpCircle,
  Edit,
  Download,
  ExternalLink,
  Maximize2,
  Clock,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Pencil,
  ZoomIn,
  MoreHorizontal,
  SlidersHorizontal,
  CircleCheck,
  Check,
  History,
  RotateCcw,
  ScanSearch,
  CarFront,
  ChevronLeft,
  ChevronRight,
  Split,
  ScrollText,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { format } from "date-fns";
import { Switch } from "@/components/ui/switch";
import { useRouter } from "next/navigation";
import PlateMatchModeSelect from "@/components/PlateMatchModeSelect";
import PlateImage from "@/components/PlateImage";
import MultiSelectFilter from "@/components/MultiSelectFilter";
import LiveFeedDateRangeFilter from "@/components/LiveFeedDateRangeFilter";
import {
  retryBlueIrisVehicleFrameForRead,
  reviewVehicleClusterSuggestion,
} from "@/app/actions";
import ImageViewer from "./ImageViewer";
import { useAccess } from "@/components/auth/AccessProvider";
import {
  findNextUnconfirmedReadIndex,
  isConfirmNextOperationCurrent,
  resolveReadViewerNavigation,
  resolveUnconfirmedPageTransition,
} from "@/lib/read-viewer-navigation.mjs";
import {
  loadLiveFeedPopupView,
  saveLiveFeedPopupView,
} from "@/lib/live-feed-popup-preference.mjs";
import {
  buildBlueIrisPlatePlaybackPath,
  buildBlueIrisTimelinePath,
  buildBlueIrisUiUrl,
} from "@/lib/blue-iris-ui-url.mjs";
import {
  elapsedMilliseconds,
  recordLiveFeedPerformance,
} from "@/lib/live-feed-performance.mjs";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";
import ResultsPagination from "@/components/ResultsPagination";
import {
  DASHBOARD_FEED_METRIC_LABELS,
  DASHBOARD_TIME_FRAME_LABELS,
} from "@/lib/dashboard-time-distribution.mjs";

const SortButton = ({ label, field, sort, onSort }) => {
  const isActive = sort.field === field;
  const Icon = isActive
    ? sort.direction === "asc"
      ? ChevronUp
      : ChevronDown
    : ChevronsUpDown;

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 p-0 hover:bg-transparent hover:text-primary data-[active=true]:text-primary flex items-center gap-1"
      onClick={() => onSort(field)}
      data-active={isActive}
    >
      {label}
      <Icon className="h-2 w-2" />
    </Button>
  );
};

const REVIEW_STATUS_LABELS = {
  unreviewed: "Unreviewed",
  confirmed: "Confirmed",
  corrected: "Corrected",
  rejected: "Rejected",
  alias_resolved: "Alias resolved",
};

const REVIEW_STATUS_CLASSES = {
  unreviewed: "border-amber-500/40 text-amber-500",
  confirmed: "border-green-500/40 text-green-500",
  corrected: "border-blue-500/40 text-blue-500",
  rejected: "border-red-500/40 text-red-500",
  alias_resolved: "border-violet-500/40 text-violet-400",
};

const POPUP_ACTION_BUTTON_CLASS = "h-8 w-full min-w-0 justify-center overflow-hidden px-1 text-[11px]";
const POPUP_ACTION_ICON_CLASS = "mr-1 h-3.5 w-3.5 shrink-0";
const POPUP_ACTION_LABEL_CLASS = "min-w-0 truncate whitespace-nowrap";
const POPUP_ACTION_GRID_CLASS = "grid w-full grid-cols-7 gap-2";
const POPUP_ACTION_SLOT_CLASS = "min-h-8 min-w-0";
const TABLE_ACTION_BUTTON_CLASS = "h-8 w-8 p-0";
const CONFIRM_NEXT_SCAN_TIMEOUT_MS = 15000;

function PopupActionSlot({ children, className = "", reserve = false }) {
  if (!reserve && !children) return null;
  return <div className={`${POPUP_ACTION_SLOT_CLASS} ${className}`.trim()}>{children}</div>;
}

function correctionImageFromRead(plate) {
  let url = null;
  if (plate?.image_path) {
    url = `/images/${plate.image_path}`;
  } else if (plate?.image_data) {
    url = plate.image_data.startsWith("data:image/jpeg;base64,")
      ? plate.image_data
      : `data:image/jpeg;base64,${plate.image_data}`;
  }

  if (!url) return null;
  return {
    url,
    plateNumber: plate.plate_number,
    crop_coordinates: plate.crop_coordinates || null,
  };
}

function correctionDraft({
  id,
  plateNumber,
  observedPlate,
  cameraName,
  image,
}) {
  return {
    id,
    plateNumber,
    observedPlate: observedPlate || plateNumber,
    cameraName: cameraName || "",
    image: image || null,
    newPlateNumber: plateNumber,
    correctAll: false,
    unreviewedOnly: true,
    batchCameraOnly: false,
    rememberAlias: false,
    aliasScope: "all",
    reason: "ocr_character_error",
    notes: "",
  };
}

function PlateIdentity({ plate, compact = false }) {
  const status = plate.review_status || (plate.validated ? "confirmed" : "unreviewed");
  const observed = plate.observed_plate || plate.plate_number;
  const wasResolved = observed !== plate.plate_number;

  return (
    <div className={compact ? "space-y-1" : "space-y-1.5"}>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/live_feed?search=${encodeURIComponent(plate.plate_number)}&matchMode=off`}
          className="text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          title={`View exact reads for ${plate.plate_number}`}
        >
          {plate.plate_number}
        </Link>
        <Badge
          variant="outline"
          className={`px-1.5 py-0 text-[10px] font-sans ${REVIEW_STATUS_CLASSES[status] || ""}`}
        >
          {REVIEW_STATUS_LABELS[status] || status}
        </Badge>
      </div>
      {wasResolved && (
        <div className="text-[11px] text-muted-foreground">
          Camera read {observed}
        </div>
      )}
      {plate.known_name && (
        <div className="text-gray-500 dark:text-gray-400 font-sans">
          {plate.known_name}
        </div>
      )}
    </div>
  );
}

function directionDisplayLabel(plate) {
  if (plate.direction_unavailable_reason === "monochrome_night_capture") {
    return "Unavailable nighttime";
  }
  if (plate.direction_label) return plate.direction_label;
  if (plate.direction_profile_configured && !plate.direction_status) return "Pending";
  return "Unknown";
}

function DirectionBadge({ plate }) {
  const label = directionDisplayLabel(plate);
  const ready = plate.direction_status === "ready" && Boolean(plate.direction_label);
  const pending = label === "Pending";
  return (
    <Badge
      variant="outline"
      className={ready
        ? "border-cyan-500/40 text-cyan-500"
        : pending
          ? "border-amber-500/40 text-amber-500"
          : "border-muted-foreground/30 text-muted-foreground"}
    >
      {label}
    </Badge>
  );
}

function PlateTimestamp({ timestamp, timeFormat }) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <time
      dateTime={value.toISOString()}
      className="block whitespace-nowrap leading-tight"
    >
      <span className="block">{value.toLocaleDateString("en-US")}</span>
      <span className="mt-0.5 block">
        {value.toLocaleTimeString("en-US", { hour12: timeFormat === 12 })}
      </span>
    </time>
  );
}

function formatSpeed(speed) {
  if (speed === null || speed === undefined || speed === "") return "—";
  const numeric = Number(speed);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric.toFixed(Number.isInteger(numeric) ? 0 : 1)} mph`;
}

export default function PlateTable({
  data,
  loading,
  availableTags,
  pagination,
  filters,
  onUpdateFilters,
  onAddTag,
  onRemoveTag,
  onAddKnownPlate,
  onDeleteRecord,
  onValidate,
  availableCameras,
  availableDirections = [],
  onCorrectPlate,
  onPreviewCorrection,
  onReviewHistory,
  onReverseReview,
  onReviewDirection,
  timeFormat = 12,
  sort = { field: "", direction: "" },
  onSort = () => {},
  matchingSettings,
  biHost,
  isLive = true,
  onLiveChange = () => {},
  onViewerOpenChange = () => {},
}) {
  const { can } = useAccess();
  const canRead = can("plate.read");
  const canReview = can("plate.review");
  const canBatchReview = can("plate.review.batch");
  const canManageAliases = can("plate.alias.manage");
  const canDelete = can("plate.delete");
  const canManageKnownPlates = can("known_plate.manage");
  const canManageTags = can("tag.manage");
  const canExport = can("export.create");
  const canViewAudit = can("system.view_audit");
  const selectedTags = Array.isArray(filters.tags)
    ? filters.tags
    : filters.tag && filters.tag !== "all"
      ? [filters.tag]
      : [];
  const selectedCameras = Array.isArray(filters.cameraNames)
    ? filters.cameraNames
    : filters.cameraName
      ? [filters.cameraName]
      : [];
  const selectedReviewStatuses = Array.isArray(filters.reviewStatuses)
    ? filters.reviewStatuses
    : [];
  const selectedDirections = Array.isArray(filters.directionLabels)
    ? filters.directionLabels
    : [];
  const tagFilterOptions = [
    { value: "untagged", label: "Untagged", color: "#6B7280" },
    ...availableTags.map((tag) => ({
      value: tag.name,
      label: tag.name,
      color: tag.color,
    })),
  ];
  const cameraFilterOptions = availableCameras.map((camera) => ({
    value: camera,
    label: camera,
  }));
  const reviewStatusFilterOptions = [
    { value: "unreviewed", label: "Unreviewed", color: "#F59E0B" },
    { value: "confirmed", label: "Confirmed", color: "#22C55E" },
    { value: "corrected", label: "Corrected", color: "#3B82F6" },
    { value: "alias_resolved", label: "Alias resolved", color: "#A78BFA" },
  ];
  const directionFilterOptions = [
    ...availableDirections.map((direction) => ({
      value: direction,
      label: direction,
      color: "#06B6D4",
    })),
    { value: "__unknown__", label: "Unknown", color: "#6B7280" },
  ];

  // Only keep state for modals and temporary form data
  const [isAddKnownPlateOpen, setIsAddKnownPlateOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [activePlate, setActivePlate] = useState(null);
  const [newKnownPlate, setNewKnownPlate] = useState({ name: "", notes: "" });
  const [correction, setCorrection] = useState(null);
  const [isCorrectPlateOpen, setIsCorrectPlateOpen] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState(null);
  const [aliasReplaceConflict, setAliasReplaceConflict] = useState(null);
  const [reverseCandidate, setReverseCandidate] = useState(null);
  const [historyState, setHistoryState] = useState({
    open: false,
    read: null,
    loading: false,
    entries: [],
    error: "",
  });
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedImageView, setSelectedImageView] = useState("plate");
  const [isImageFullscreen, setIsImageFullscreen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [pendingReviewReadId, setPendingReviewReadId] = useState(null);
  const [pendingReviewTargetValidated, setPendingReviewTargetValidated] = useState(null);
  const [pendingViewerNavigation, setPendingViewerNavigation] = useState(null);
  const [pendingUnconfirmedNavigation, setPendingUnconfirmedNavigation] = useState(null);
  const [confirmNextOperation, setConfirmNextOperation] = useState(null);
  const [navigationWatchdogTick, setNavigationWatchdogTick] = useState(0);
  const [pendingVehicleReview, setPendingVehicleReview] = useState("");
  const [pendingDirectionReview, setPendingDirectionReview] = useState("");
  const [pendingVehicleImageRetry, setPendingVehicleImageRetry] = useState(false);
  const [vehicleImageRetryError, setVehicleImageRetryError] = useState("");
  const [isDirectionReviewOpen, setIsDirectionReviewOpen] = useState(false);
  const [directionReviewError, setDirectionReviewError] = useState("");
  const [searchInput, setSearchInput] = useState(filters.search || "");
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const [isSearchOptionsOpen, setIsSearchOptionsOpen] = useState(false);

  const correctionInputRef = useRef(null);
  const confirmNextTokenSequenceRef = useRef(0);
  const activeConfirmNextOperationRef = useRef(null);
  const selectedImageIdRef = useRef(null);
  const viewerNavigationTimingRef = useRef(null);

  const router = useRouter();

  useEffect(() => {
    selectedImageIdRef.current = selectedImage?.id ?? null;
  }, [selectedImage?.id]);

  useEffect(() => {
    onViewerOpenChange(selectedImage !== null);
  }, [onViewerOpenChange, selectedImage]);

  const cancelConfirmNextOperation = useCallback(() => {
    activeConfirmNextOperationRef.current = null;
    setConfirmNextOperation(null);
  }, []);

  const cancelConfirmNextFlow = useCallback(() => {
    activeConfirmNextOperationRef.current = null;
    setConfirmNextOperation(null);
    setPendingUnconfirmedNavigation(null);
  }, []);

  const closeImageViewer = useCallback(() => {
    cancelConfirmNextFlow();
    selectedImageIdRef.current = null;
    viewerNavigationTimingRef.current = null;
    setIsImageFullscreen(false);
    setSelectedImage(null);
    setSelectedIndex(-1);
    setPendingViewerNavigation(null);
    setPendingUnconfirmedNavigation(null);
  }, [cancelConfirmNextFlow]);

  const handlePlateFilterNavigation = useCallback(() => {
    onLiveChange(false);
    closeImageViewer();
  }, [closeImageViewer, onLiveChange]);

  useEffect(() => () => {
    activeConfirmNextOperationRef.current = null;
    selectedImageIdRef.current = null;
    viewerNavigationTimingRef.current = null;
  }, []);

  useEffect(() => {
    setSelectedImageView(loadLiveFeedPopupView());
  }, []);

  const handleSelectedImageViewChange = useCallback((view) => {
    setSelectedImageView(saveLiveFeedPopupView(view));
  }, []);

  const handleCorrectionPlateChange = useCallback((event) => {
    const input = event.currentTarget;
    const value = input.value;
    const selectionStart = input.selectionStart ?? value.length;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    const nextValue = value.toUpperCase();
    const nextSelectionStart = value.slice(0, selectionStart).toUpperCase().length;
    const nextSelectionEnd = value.slice(0, selectionEnd).toUpperCase().length;

    setCorrection((current) => ({
      ...current,
      newPlateNumber: nextValue,
    }));
    requestAnimationFrame(() => {
      if (correctionInputRef.current !== input || document.activeElement !== input) return;
      input.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }, []);

  const handleVehicleReview = async (decision) => {
    if (
      !selectedImage?.id ||
      pendingVehicleReview ||
      activeConfirmNextOperationRef.current ||
      pendingUnconfirmedNavigation
    ) return;
    setPendingVehicleReview(decision);
    try {
      const result = await reviewVehicleClusterSuggestion({ readId: selectedImage.id, decision });
      if (!result.success) return;
      setSelectedImage((previous) => previous ? {
        ...previous,
        vehicleClusterId: Number(result.data.cluster_id),
        vehicleClusterStatus: result.data.assignment_status,
        vehicleClusterSimilarity: result.data.similarity === null ? null : Number(result.data.similarity),
      } : previous);
      router.refresh();
    } finally {
      setPendingVehicleReview("");
    }
  };

  const handleDirectionReview = async (orientation) => {
    if (
      !selectedImage?.id ||
      pendingDirectionReview ||
      typeof onReviewDirection !== "function" ||
      activeConfirmNextOperationRef.current ||
      pendingUnconfirmedNavigation
    ) return;
    setPendingDirectionReview(orientation);
    setDirectionReviewError("");
    try {
      const result = await onReviewDirection(selectedImage.id, orientation);
      if (!result?.success) {
        setDirectionReviewError(result?.error || "Unable to correct the direction.");
        return;
      }
      const observation = result.data?.observation;
      setSelectedImage((previous) => previous ? {
        ...previous,
        directionStatus: observation?.status || previous.directionStatus,
        vehicleOrientation: observation?.orientation || orientation,
        directionConfidence: observation?.confidence === null || observation?.confidence === undefined
          ? previous.directionConfidence
          : Number(observation.confidence),
        directionLabel: observation?.directionLabel || previous.directionLabel,
      } : previous);
      setIsDirectionReviewOpen(false);
    } finally {
      setPendingDirectionReview("");
    }
  };

  const handleVehicleImageRetry = async () => {
    if (
      !selectedImage?.id ||
      pendingVehicleImageRetry ||
      activeConfirmNextOperationRef.current ||
      pendingUnconfirmedNavigation
    ) return;
    setPendingVehicleImageRetry(true);
    setVehicleImageRetryError("");
    try {
      const result = await retryBlueIrisVehicleFrameForRead(selectedImage.id);
      if (!result?.success) {
        setVehicleImageRetryError(result?.error || "Unable to retry this vehicle view.");
        return;
      }
      setSelectedImage((previous) => previous ? {
        ...previous,
        vehicleImageStatus: "pending",
        vehicleImageErrorCode: null,
        vehicleImageAttemptCount: 0,
        vehicleImageRetryable: true,
      } : previous);
      router.refresh();
    } finally {
      setPendingVehicleImageRetry(false);
    }
  };

  useEffect(() => {
    setIsDirectionReviewOpen(false);
    setDirectionReviewError("");
    setVehicleImageRetryError("");
  }, [selectedImage?.id]);

  // Helper functions
  const getImageUrl = (base64Data) => {
    if (!base64Data) return "/placeholder-image.jpg";
    if (base64Data.startsWith("data:image/jpeg;base64,")) return base64Data;
    return `data:image/jpeg;base64,${base64Data}`;
  };

  const handleImageClick = useCallback((e, plate) => {
    e.preventDefault();
    cancelConfirmNextFlow();
    selectedImageIdRef.current = plate.id;
    const plateIndex = data.findIndex((p) => p.id === plate.id);
    let imageUrl;
    let thumbnailUrl;
    let bi_url = null;
    let crop_coordinates = null;
    if (plate.image_path) {
      // imageUrl = `/images/images/${plate.image_path.replace(/^images\//, "")}`;
      imageUrl = `/images/${plate.image_path}`;
      thumbnailUrl = `/images/${plate.thumbnail_path}`;
    } else if (plate.image_data) {
      // Handle legacy base64 data
      imageUrl = plate.image_data.startsWith("data:image/jpeg;base64,")
        ? plate.image_data
        : `data:image/jpeg;base64,${plate.image_data}`;
    } else {
      return; // No image available
    }

    if (plate.bi_path) {
      bi_url = plate.bi_path;
    }

    if (plate.crop_coordinates) {
      crop_coordinates = plate.crop_coordinates;
    }

    if (viewerNavigationTimingRef.current) {
      viewerNavigationTimingRef.current = {
        ...viewerNavigationTimingRef.current,
        targetReadId: Number(plate.id),
        targetCamera: plate.camera_name || "",
      };
    }

    setSelectedIndex(plateIndex);
    setSelectedImage({
      url: imageUrl,
      plateCaptureUrl: imageUrl,
      vehicleImageUrl: plate.vehicle_image_path ? `/images/${plate.vehicle_image_path}` : null,
      vehicleImageStatus: plate.vehicle_image_status || null,
      vehicleImageErrorCode: plate.vehicle_image_error_code || null,
      vehicleImageQueueKind: plate.vehicle_image_queue_kind || null,
      vehicleImageAttemptCount: Number(plate.vehicle_image_attempt_count || 0),
      vehicleImageRetryable: plate.vehicle_image_retryable !== false,
      vehicleImageTimestamp: plate.vehicle_image_timestamp || null,
      vehicleImageDetectionBox: plate.vehicle_image_detection_box || null,
      vehicleImageWidth: Number(plate.vehicle_image_width || 0) || null,
      vehicleImageHeight: Number(plate.vehicle_image_height || 0) || null,
      thumbnail: thumbnailUrl,
      plateNumber: plate.plate_number,
      observedPlate: plate.observed_plate || plate.plate_number,
      reviewStatus: plate.review_status || (plate.validated ? "confirmed" : "unreviewed"),
      reviewRevision: plate.review_revision || 0,
      occurrenceCount: plate.occurrence_count ?? null,
      timestamp: plate.timestamp,
      speedMph: plate.speed_mph == null ? null : Number(plate.speed_mph),
      radarDirection: plate.radar_direction || null,
      radarTimestamp: plate.radar_timestamp || null,
      radarMatchDeltaMs: plate.radar_match_delta_ms == null ? null : Number(plate.radar_match_delta_ms),
      appliedAliasId: plate.applied_alias_id || null,
      cameraName: plate.camera_name || "",
      knownName: plate.known_name || "",
      tags: Array.isArray(plate.tags) ? plate.tags : [],
      directionStatus: plate.direction_status || null,
      vehicleOrientation: plate.vehicle_orientation || "unknown",
      directionConfidence: plate.orientation_confidence === null || plate.orientation_confidence === undefined
        ? null
        : Number(plate.orientation_confidence),
      directionLabel: plate.direction_label || "",
      directionUnavailableReason: plate.direction_unavailable_reason || null,
      directionProfileConfigured: plate.direction_profile_configured === true,
      vehicleColor: plate.vehicle_color || "",
      vehicleColorStatus: plate.vehicle_color_status || "",
      vehicleColorConfidence: plate.vehicle_color_confidence === null || plate.vehicle_color_confidence === undefined
        ? null
        : Number(plate.vehicle_color_confidence),
      vehicleBodyType: plate.vehicle_body_type || "",
      vehicleBodyTypeConfidence: plate.vehicle_body_type_confidence === null
        || plate.vehicle_body_type_confidence === undefined
        ? null
        : Number(plate.vehicle_body_type_confidence),
      vehicleClusterId: plate.vehicle_cluster_id ? Number(plate.vehicle_cluster_id) : null,
      vehicleClusterStatus: plate.vehicle_cluster_status || null,
      vehicleClusterSimilarity: plate.vehicle_cluster_similarity === null || plate.vehicle_cluster_similarity === undefined
        ? null
        : Number(plate.vehicle_cluster_similarity),
      vehicleIdentityMode: plate.vehicle_identity_mode || "v1_primary",
      vehicleProfileId: plate.vehicle_profile_id ? Number(plate.vehicle_profile_id) : null,
      vehicleProfileAssignmentBasis: plate.vehicle_profile_assignment_basis || null,
      vehicleFindSimilarAvailable: plate.vehicle_find_similar_available !== false,
      id: plate.id,
      validated: plate.validated,
      bi_path: bi_url,
      plateBiCamera: plate.plate_bi_camera || null,
      vehicleBiCamera: plate.vehicle_bi_camera || null,
      crop_coordinates: plate.crop_coordinates,
    });

  }, [cancelConfirmNextFlow, data]);

  const getViewerNavigation = useCallback(
    (direction) => {
      const currentDataIndex = selectedImage
        ? data.findIndex((plate) => plate.id === selectedImage.id)
        : selectedIndex;
      return resolveReadViewerNavigation({
        direction,
        selectedIndex: currentDataIndex >= 0 ? currentDataIndex : selectedIndex,
        selectedPresent: currentDataIndex >= 0,
        itemCount: data.length,
        page: pagination.page,
        pageSize: pagination.pageSize,
        total: pagination.total,
      });
    },
    [
      data,
      pagination.page,
      pagination.pageSize,
      pagination.total,
      selectedImage,
      selectedIndex,
    ]
  );
  const onViewerPageChange = pagination.onViewerPageChange;
  const onViewerDataRefresh = pagination.onViewerDataRefresh;

  const handleViewerNavigation = useCallback((direction) => {
    if (
      !selectedImage ||
      pendingViewerNavigation ||
      pendingUnconfirmedNavigation ||
      activeConfirmNextOperationRef.current
    ) return;

    const destination = getViewerNavigation(direction);
    if (destination.kind === "none") return;

    viewerNavigationTimingRef.current = {
      metric: "viewer_navigation",
      operation: direction,
      boundary: destination.kind === "item" ? "same_page" : "cross_page",
      startedAt: performance.now(),
      sourceReadId: Number(selectedImage.id),
      sourceCamera: selectedImage.cameraName || "",
      targetPage: destination.kind === "page" ? destination.page : pagination.page,
      targetReadId: destination.kind === "item"
        ? Number(data[destination.index]?.id)
        : null,
      targetCamera: destination.kind === "item"
        ? data[destination.index]?.camera_name || ""
        : "",
    };
    if (destination.kind === "item") {
      handleImageClick(
        { preventDefault: () => {} },
        data[destination.index]
      );
      return;
    }

    if (
      destination.kind === "page" &&
      typeof onViewerPageChange === "function"
    ) {
      setPendingViewerNavigation(destination);
      onViewerPageChange(direction);
    }
  }, [
    data,
    getViewerNavigation,
    handleImageClick,
    onViewerPageChange,
    pendingUnconfirmedNavigation,
    pendingViewerNavigation,
    pagination.page,
    selectedImage,
  ]);

  const handleNextImage = useCallback(() => {
    handleViewerNavigation("next");
  }, [handleViewerNavigation]);

  const handlePreviousImage = useCallback(() => {
    handleViewerNavigation("previous");
  }, [handleViewerNavigation]);

  useEffect(() => {
    if (
      !pendingViewerNavigation ||
      pendingViewerNavigation.page !== pagination.page ||
      data.length === 0
    ) {
      return;
    }

    const targetIndex =
      pendingViewerNavigation.index < 0
        ? data.length - 1
        : pendingViewerNavigation.index;
    handleImageClick({ preventDefault: () => {} }, data[targetIndex]);
    setPendingViewerNavigation(null);
  }, [data, handleImageClick, pagination.page, pendingViewerNavigation]);

  // Cycle through images without clicking out, including across result pages.
  useEffect(() => {
    const handleKeyPress = (event) => {
      // Leave arrow keys to editable controls and the zoom slider.
      if (
        document.activeElement?.matches(
          'input, textarea, select, [role="slider"], [contenteditable="true"]'
        )
      ) {
        return;
      }

      if (
        selectedImage === null ||
        pendingUnconfirmedNavigation !== null ||
        activeConfirmNextOperationRef.current
      ) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        handleNextImage();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        handlePreviousImage();
      }
    };

    if (selectedImage) {
      window.addEventListener("keydown", handleKeyPress);
      return () => window.removeEventListener("keydown", handleKeyPress);
    }
  }, [handleNextImage, handlePreviousImage, pendingUnconfirmedNavigation, selectedImage]);

  const hasNextImage =
    selectedImage !== null && getViewerNavigation("next").kind !== "none";
  const hasPreviousImage =
    selectedImage !== null && getViewerNavigation("previous").kind !== "none";
  const selectedDataIndex = selectedImage
    ? data.findIndex((plate) => plate.id === selectedImage.id)
    : selectedIndex;
  const nextUnconfirmedIndex = selectedImage
    ? findNextUnconfirmedReadIndex({
        reads: data,
        selectedIndex: selectedDataIndex >= 0 ? selectedDataIndex : selectedIndex,
        selectedPresent: selectedDataIndex >= 0,
      })
    : -1;
  const hasLaterResultPage = pagination.page * pagination.pageSize < pagination.total;
  const hasNextUnconfirmedRead =
    selectedImage !== null &&
    selectedImage.validated !== true &&
    (nextUnconfirmedIndex >= 0 ||
      (hasLaterResultPage && typeof onViewerPageChange === "function"));
  const confirmNextBusy =
    confirmNextOperation !== null || pendingUnconfirmedNavigation !== null;
  const displayedImageView =
    selectedImageView === "vehicle" && selectedImage?.vehicleImageUrl
      ? "vehicle"
    : "plate";
  const selectedBlueIrisPath = displayedImageView === "vehicle"
    ? buildBlueIrisTimelinePath(
        selectedImage?.vehicleBiCamera,
        selectedImage?.vehicleImageTimestamp || selectedImage?.timestamp,
      )
    : buildBlueIrisPlatePlaybackPath(
        selectedImage?.bi_path,
        selectedImage?.plateBiCamera,
        selectedImage?.timestamp,
      );

  const handleViewerImageLoad = useCallback(({ url, width, height }) => {
    const timing = viewerNavigationTimingRef.current;
    if (!timing || !selectedImage?.id) return;
    if (timing.targetReadId && timing.targetReadId !== Number(selectedImage.id)) return;

    recordLiveFeedPerformance({
      ...timing,
      durationMs: elapsedMilliseconds(timing.startedAt, performance.now()),
      outcome: "image_loaded",
      targetReadId: Number(selectedImage.id),
      targetCamera: selectedImage.cameraName || timing.targetCamera || "",
      imageView: displayedImageView,
      imageUrlKind: String(url || "").startsWith("data:") ? "inline" : "stored_file",
      imageWidth: width,
      imageHeight: height,
    });
    viewerNavigationTimingRef.current = null;
  }, [displayedImageView, selectedImage]);

  useEffect(() => {
    if (selectedImage && data && data.length > 0) {
      const currentPlate = data.find((plate) => plate.id === selectedImage.id);
      if (pendingReviewReadId === selectedImage.id) return;
      const currentReviewStatus = currentPlate
        ? currentPlate.review_status ||
          (currentPlate.validated ? "confirmed" : "unreviewed")
        : null;
      const currentReviewRevision = Number(currentPlate?.review_revision || 0);
      const selectedReviewRevision = Number(selectedImage.reviewRevision || 0);
      const canSyncReview = currentReviewRevision >= selectedReviewRevision;
      const currentKnownName = currentPlate?.known_name || "";
      const currentOccurrenceCount = currentPlate?.occurrence_count ?? null;
      const currentTags = Array.isArray(currentPlate?.tags) ? currentPlate.tags : [];
      const selectedImageTags = Array.isArray(selectedImage.tags)
        ? selectedImage.tags
        : [];
      const currentTagSignature = JSON.stringify(currentTags);
      const selectedTagSignature = JSON.stringify(selectedImageTags);
      const currentDirectionLabel = currentPlate?.direction_label || "";
      const currentDirectionStatus = currentPlate?.direction_status || null;
      const currentDirectionUnavailableReason = currentPlate?.direction_unavailable_reason || null;
      const currentDirectionProfileConfigured = currentPlate?.direction_profile_configured === true;
      const currentVehicleOrientation = currentPlate?.vehicle_orientation || "unknown";
      const currentDirectionConfidence = currentPlate?.orientation_confidence === null
        || currentPlate?.orientation_confidence === undefined
        ? null
        : Number(currentPlate.orientation_confidence);
      const currentVehicleColor = currentPlate?.vehicle_color || "";
      const currentVehicleColorStatus = currentPlate?.vehicle_color_status || "";
      const currentVehicleColorConfidence = currentPlate?.vehicle_color_confidence === null
        || currentPlate?.vehicle_color_confidence === undefined
        ? null
        : Number(currentPlate.vehicle_color_confidence);
      const currentVehicleBodyType = currentPlate?.vehicle_body_type || "";
      const currentVehicleBodyTypeConfidence = currentPlate?.vehicle_body_type_confidence === null
        || currentPlate?.vehicle_body_type_confidence === undefined
        ? null
        : Number(currentPlate.vehicle_body_type_confidence);
      const currentVehicleClusterId = currentPlate?.vehicle_cluster_id ? Number(currentPlate.vehicle_cluster_id) : null;
      const currentVehicleClusterStatus = currentPlate?.vehicle_cluster_status || null;
      const currentVehicleClusterSimilarity = currentPlate?.vehicle_cluster_similarity === null
        || currentPlate?.vehicle_cluster_similarity === undefined
        ? null
        : Number(currentPlate.vehicle_cluster_similarity);
      const currentVehicleIdentityMode = currentPlate?.vehicle_identity_mode || "v1_primary";
      const currentVehicleProfileId = currentPlate?.vehicle_profile_id
        ? Number(currentPlate.vehicle_profile_id)
        : null;
      const currentVehicleProfileAssignmentBasis = currentPlate?.vehicle_profile_assignment_basis || null;
      const currentVehicleFindSimilarAvailable = currentPlate?.vehicle_find_similar_available !== false;
      const currentVehicleImageUrl = currentPlate?.vehicle_image_path
        ? `/images/${currentPlate.vehicle_image_path}`
        : null;
      const currentVehicleImageStatus = currentPlate?.vehicle_image_status || null;
      const currentVehicleImageErrorCode = currentPlate?.vehicle_image_error_code || null;
      const currentVehicleImageQueueKind = currentPlate?.vehicle_image_queue_kind || null;
      const currentVehicleImageAttemptCount = Number(currentPlate?.vehicle_image_attempt_count || 0);
      const currentVehicleImageRetryable = currentPlate?.vehicle_image_retryable !== false;
      const currentVehicleImageTimestamp = currentPlate?.vehicle_image_timestamp || null;
      const currentVehicleImageDetectionBox = currentPlate?.vehicle_image_detection_box || null;
      const currentVehicleImageWidth = Number(currentPlate?.vehicle_image_width || 0) || null;
      const currentVehicleImageHeight = Number(currentPlate?.vehicle_image_height || 0) || null;
      const currentPlateBiCamera = currentPlate?.plate_bi_camera || null;
      const currentVehicleBiCamera = currentPlate?.vehicle_bi_camera || null;
      const currentVehicleImageDetectionSignature = JSON.stringify(currentVehicleImageDetectionBox);
      const selectedVehicleImageDetectionSignature = JSON.stringify(selectedImage.vehicleImageDetectionBox);

      if (
        currentPlate &&
        ((canSyncReview &&
          (currentPlate.validated !== selectedImage.validated ||
            currentPlate.plate_number !== selectedImage.plateNumber ||
            currentReviewStatus !== selectedImage.reviewStatus ||
            currentReviewRevision !== selectedReviewRevision)) ||
          currentKnownName !== selectedImage.knownName ||
          currentOccurrenceCount !== selectedImage.occurrenceCount ||
          currentTagSignature !== selectedTagSignature ||
          currentDirectionStatus !== selectedImage.directionStatus ||
          currentVehicleOrientation !== selectedImage.vehicleOrientation ||
          currentDirectionLabel !== selectedImage.directionLabel ||
          currentDirectionUnavailableReason !== selectedImage.directionUnavailableReason ||
          currentDirectionProfileConfigured !== selectedImage.directionProfileConfigured ||
          currentDirectionConfidence !== selectedImage.directionConfidence ||
          currentVehicleColor !== selectedImage.vehicleColor ||
          currentVehicleColorStatus !== selectedImage.vehicleColorStatus ||
          currentVehicleColorConfidence !== selectedImage.vehicleColorConfidence ||
          currentVehicleBodyType !== selectedImage.vehicleBodyType ||
          currentVehicleBodyTypeConfidence !== selectedImage.vehicleBodyTypeConfidence ||
          currentVehicleClusterId !== selectedImage.vehicleClusterId ||
          currentVehicleClusterStatus !== selectedImage.vehicleClusterStatus ||
          currentVehicleClusterSimilarity !== selectedImage.vehicleClusterSimilarity ||
          currentVehicleIdentityMode !== selectedImage.vehicleIdentityMode ||
          currentVehicleProfileId !== selectedImage.vehicleProfileId ||
          currentVehicleProfileAssignmentBasis !== selectedImage.vehicleProfileAssignmentBasis ||
          currentVehicleFindSimilarAvailable !== selectedImage.vehicleFindSimilarAvailable ||
          currentVehicleImageUrl !== selectedImage.vehicleImageUrl ||
          currentVehicleImageStatus !== selectedImage.vehicleImageStatus ||
          currentVehicleImageErrorCode !== selectedImage.vehicleImageErrorCode ||
          currentVehicleImageQueueKind !== selectedImage.vehicleImageQueueKind ||
          currentVehicleImageAttemptCount !== selectedImage.vehicleImageAttemptCount ||
          currentVehicleImageRetryable !== selectedImage.vehicleImageRetryable ||
          currentVehicleImageTimestamp !== selectedImage.vehicleImageTimestamp ||
          currentVehicleImageDetectionSignature !== selectedVehicleImageDetectionSignature ||
          currentVehicleImageWidth !== selectedImage.vehicleImageWidth ||
          currentVehicleImageHeight !== selectedImage.vehicleImageHeight ||
          currentPlateBiCamera !== selectedImage.plateBiCamera ||
          currentVehicleBiCamera !== selectedImage.vehicleBiCamera)
      ) {
        setSelectedImage((previous) => ({
          ...previous,
          ...(canSyncReview
            ? {
                validated: currentPlate.validated,
                plateNumber: currentPlate.plate_number,
                observedPlate:
                  currentPlate.observed_plate || currentPlate.plate_number,
                reviewStatus: currentReviewStatus,
                reviewRevision: currentReviewRevision,
              }
            : {}),
          knownName: currentKnownName,
          occurrenceCount: currentOccurrenceCount,
          tags: currentTags,
          directionStatus: currentPlate.direction_status || null,
          vehicleOrientation: currentPlate.vehicle_orientation || "unknown",
          directionConfidence: currentDirectionConfidence,
          directionLabel: currentDirectionLabel,
          directionUnavailableReason: currentDirectionUnavailableReason,
          directionProfileConfigured: currentDirectionProfileConfigured,
          vehicleColor: currentVehicleColor,
          vehicleColorStatus: currentVehicleColorStatus,
          vehicleColorConfidence: currentVehicleColorConfidence,
          vehicleBodyType: currentVehicleBodyType,
          vehicleBodyTypeConfidence: currentVehicleBodyTypeConfidence,
          vehicleClusterId: currentVehicleClusterId,
          vehicleClusterStatus: currentVehicleClusterStatus,
          vehicleClusterSimilarity: currentVehicleClusterSimilarity,
          vehicleIdentityMode: currentVehicleIdentityMode,
          vehicleProfileId: currentVehicleProfileId,
          vehicleProfileAssignmentBasis: currentVehicleProfileAssignmentBasis,
          vehicleFindSimilarAvailable: currentVehicleFindSimilarAvailable,
          vehicleImageUrl: currentVehicleImageUrl,
          vehicleImageStatus: currentVehicleImageStatus,
          vehicleImageErrorCode: currentVehicleImageErrorCode,
          vehicleImageQueueKind: currentVehicleImageQueueKind,
          vehicleImageAttemptCount: currentVehicleImageAttemptCount,
          vehicleImageRetryable: currentVehicleImageRetryable,
          vehicleImageTimestamp: currentVehicleImageTimestamp,
          vehicleImageDetectionBox: currentVehicleImageDetectionBox,
          vehicleImageWidth: currentVehicleImageWidth,
          vehicleImageHeight: currentVehicleImageHeight,
          plateBiCamera: currentPlateBiCamera,
          vehicleBiCamera: currentVehicleBiCamera,
        }));
      }
    }
  }, [data, pendingReviewReadId, selectedImage]);

  const handleSelectedImageValidation = async () => {
    if (!selectedImage || pendingReviewReadId === selectedImage.id) return false;

    const readId = selectedImage.id;
    const nextValidated = !selectedImage.validated;
    const reviewStartedAt = performance.now();
    let reviewSucceeded = false;
    const previousReviewState = {
      validated: selectedImage.validated,
      plateNumber: selectedImage.plateNumber,
      reviewStatus: selectedImage.reviewStatus,
      reviewRevision: selectedImage.reviewRevision,
    };
    const rollbackReviewState = () => {
      setSelectedImage((previous) =>
        previous?.id === readId
          ? { ...previous, ...previousReviewState }
          : previous
      );
    };
    setPendingReviewReadId(readId);
    setPendingReviewTargetValidated(nextValidated);
    setSelectedImage((previous) =>
      previous?.id === readId
        ? {
            ...previous,
            validated: nextValidated,
            reviewStatus: nextValidated ? "confirmed" : "unreviewed",
            reviewRevision: Number(previous.reviewRevision || 0) + 1,
          }
        : previous
    );
    try {
      const result = await onValidate(readId, nextValidated);
      if (!result?.success) {
        rollbackReviewState();
        return false;
      }

      setSelectedImage((previous) => {
        if (!previous || previous.id !== readId) return previous;
        return {
          ...previous,
          validated: nextValidated,
          plateNumber: result.data?.effectivePlate || previous.plateNumber,
          reviewStatus:
            result.data?.reviewStatus ||
            (nextValidated ? "confirmed" : "unreviewed"),
          reviewRevision:
            result.data?.reviewRevision ?? previous.reviewRevision,
        };
      });
      reviewSucceeded = true;
      return true;
    } catch (error) {
      rollbackReviewState();
      console.error("Failed to update plate review:", error);
      return false;
    } finally {
      recordLiveFeedPerformance({
        metric: "review_action",
        operation: nextValidated ? "confirm" : "reopen",
        durationMs: elapsedMilliseconds(reviewStartedAt, performance.now()),
        success: reviewSucceeded,
        readId: Number(readId),
        camera: selectedImage.cameraName || "",
      });
      setPendingReviewReadId((current) => (current === readId ? null : current));
      setPendingReviewTargetValidated(null);
    }
  };

  const handleConfirmAndNext = async () => {
    if (
      !selectedImage ||
      !hasNextUnconfirmedRead ||
      activeConfirmNextOperationRef.current ||
      pendingUnconfirmedNavigation
    ) return;
    const token = confirmNextTokenSequenceRef.current + 1;
    confirmNextTokenSequenceRef.current = token;
    const origin = {
      originPage: pagination.page,
      originReadId: selectedImage.id,
      originIndex: selectedDataIndex >= 0 ? selectedDataIndex : selectedIndex,
    };
    const operation = { token, ...origin };
    activeConfirmNextOperationRef.current = operation;
    setConfirmNextOperation(operation);
    const nextRead = nextUnconfirmedIndex >= 0 ? data[nextUnconfirmedIndex] : null;
    const waitsForFilteredBoundaryRefresh =
      !nextRead &&
      selectedReviewStatuses.length > 0 &&
      !selectedReviewStatuses.includes("confirmed");
    viewerNavigationTimingRef.current = {
      metric: "viewer_navigation",
      operation: "confirm_and_next",
      boundary: nextRead ? "same_page" : "cross_page",
      startedAt: performance.now(),
      sourceReadId: Number(selectedImage.id),
      sourceCamera: selectedImage.cameraName || "",
      targetPage: nextRead ? pagination.page : pagination.page + 1,
      targetReadId: nextRead ? Number(nextRead.id) : null,
      targetCamera: nextRead?.camera_name || "",
    };
    const confirmed = await handleSelectedImageValidation();
    if (!isConfirmNextOperationCurrent({
      activeToken: activeConfirmNextOperationRef.current?.token ?? null,
      operationToken: token,
      selectedReadId: selectedImageIdRef.current,
      originReadId: origin.originReadId,
    })) return;
    if (!confirmed) {
      const timing = viewerNavigationTimingRef.current;
      if (timing?.operation === "confirm_and_next") {
        recordLiveFeedPerformance({
          ...timing,
          durationMs: elapsedMilliseconds(timing.startedAt, performance.now()),
          outcome: "review_failed",
        });
        viewerNavigationTimingRef.current = null;
      }
      cancelConfirmNextOperation();
      return;
    }
    cancelConfirmNextOperation();
    if (nextRead) {
      handleImageClick({ preventDefault: () => {} }, nextRead);
      return;
    }
    const pending = {
      ...origin,
      deadlineAt: Date.now() + CONFIRM_NEXT_SCAN_TIMEOUT_MS,
    };
    if (
      waitsForFilteredBoundaryRefresh &&
      typeof onViewerDataRefresh === "function"
    ) {
      setPendingUnconfirmedNavigation({
        ...pending,
        phase: "await-filtered-removal",
        targetPage: origin.originPage,
        originDataRevision: pagination.dataRevision,
      });
      onViewerDataRefresh();
      return;
    }
    if (hasLaterResultPage && typeof onViewerPageChange === "function") {
      setPendingUnconfirmedNavigation({
        ...pending,
        phase: "scan",
        targetPage: origin.originPage + 1,
      });
      onViewerPageChange("next");
    }
  };

  useEffect(() => {
    const pending = pendingUnconfirmedNavigation;
    if (!pending) return;
    if (
      pending.phase === "await-filtered-removal" &&
      pending.originDataRevision === pagination.dataRevision &&
      Date.now() < pending.deadlineAt
    ) {
      return;
    }
    const transition = resolveUnconfirmedPageTransition({
      pending,
      reads: data,
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: pagination.total,
      now: Date.now(),
      restoreTimeoutMs: CONFIRM_NEXT_SCAN_TIMEOUT_MS,
    });
    if (transition.kind === "wait") return;
    if (transition.kind === "open") {
      handleImageClick({ preventDefault: () => {} }, data[transition.index]);
      return;
    }
    if (transition.kind === "navigate") {
      setPendingUnconfirmedNavigation(transition.pending);
      onViewerPageChange?.(transition.direction);
      return;
    }
    setPendingUnconfirmedNavigation(null);
  }, [
    data,
    handleImageClick,
    navigationWatchdogTick,
    onViewerPageChange,
    pagination.page,
    pagination.pageSize,
    pagination.dataRevision,
    pagination.total,
    pendingUnconfirmedNavigation,
  ]);

  useEffect(() => {
    const pending = pendingUnconfirmedNavigation;
    if (!pending) return undefined;
    const remaining = Math.max(0, pending.deadlineAt - Date.now());
    const timeout = window.setTimeout(
      () => setNavigationWatchdogTick((current) => current + 1),
      remaining
    );
    return () => window.clearTimeout(timeout);
  }, [pendingUnconfirmedNavigation]);

  const handleDownloadImage = async () => {
    if (!selectedImage) return;

    try {
      // For base64 images
      if (selectedImage.url.startsWith("data:")) {
        const link = document.createElement("a");
        link.href = selectedImage.url;
        link.download = `plate-${selectedImage.plateNumber}.jpg`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      // For file-based images, fetch from API
      const response = await fetch(selectedImage.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `plate-${selectedImage.plateNumber}.jpg`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Error downloading image:", error);
    }
  };

  const handleOpenInNewTab = () => {
    if (!selectedImage) return;

    // If it's a regular file path just open the URL directly
    if (!selectedImage.url.startsWith("data:")) {
      window.open(selectedImage.url, "_blank");
      return;
    }

    const win = window.open();
    if (win) {
      win.document.write(`
        <html>
          <head>
            <title>License Plate Image - ${selectedImage.plateNumber}</title>
            <style>
              body {
                margin: 0;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                background: #000;
              }
              img {
                max-width: 100%;
                max-height: 100vh;
                object-fit: contain;
              }
            </style>
          </head>
          <body>
            <img src="${selectedImage.url}" 
                 alt="${selectedImage.plateNumber}"
                 onerror="this.onerror=null; this.src='/placeholder.jpg';" />
          </body>
        </html>
      `);
    }
  };

  const handleSearchChange = (e) => {
    const value = e.target.value.toUpperCase();
    const cursorPosition = e.target.selectionStart;
    // Save cursor position
    setTimeout(() => {
      e.target.setSelectionRange(cursorPosition, cursorPosition);
    }, 0);
    setSearchInput(value);

    // Delay the actual filter update
    setTimeout(() => {
      onUpdateFilters({ search: value });
    }, 300);
  };

  const handleMatchModeChange = (matchMode) => {
    onUpdateFilters({ matchMode, fuzzySearch: null });
  };

  const handleTagChange = (values) => {
    onUpdateFilters({ tag: values });
  };

  const handleCameraChange = (values) => {
    onUpdateFilters({ camera: values });
  };

  const handleReviewStatusChange = (values) => {
    onUpdateFilters({ reviewStatus: values });
  };

  const handleDirectionChange = (values) => {
    onUpdateFilters({ direction: values });
  };

  const applySpeedFilter = (name, value) => {
    const normalized = String(value || "").trim();
    onUpdateFilters({ [name]: normalized || null });
  };

  const handleDateRangeChange = useCallback((range) => {
    if (!range) {
      onUpdateFilters({
        dateFrom: null,
        dateTo: null,
        timestampFrom: null,
        timestampTo: null,
        timeZone: null,
        timeFrame: null,
      });
      return;
    }
    onUpdateFilters({
      dateFrom: range.from.toDateString(),
      dateTo: range.to.toDateString(),
      timestampFrom: null,
      timestampTo: null,
      timeZone: null,
      timeFrame: null,
    });
  }, [onUpdateFilters]);

  const handlePageSizeChange = (value) => {
    onUpdateFilters({ pageSize: value });
  };

  const handleAddKnownPlateSubmit = async () => {
    if (!activePlate) return;
    const result = await onAddKnownPlate(
      activePlate.plate_number,
      newKnownPlate.name,
      newKnownPlate.notes
    );
    if (!result?.success) return;
    setSelectedImage((previous) =>
      previous?.plateNumber === activePlate.plate_number
        ? { ...previous, knownName: newKnownPlate.name }
        : previous
    );
    setIsAddKnownPlateOpen(false);
    setNewKnownPlate({ name: "", notes: "" });
  };

  const handleSelectedImageAddTag = async (tag) => {
    if (
      !selectedImage ||
      activeConfirmNextOperationRef.current ||
      pendingUnconfirmedNavigation
    ) return;
    const plateNumber = selectedImage.plateNumber;
    const result = await onAddTag(plateNumber, tag.name);
    if (!result?.success) return;

    setSelectedImage((previous) => {
      if (!previous || previous.plateNumber !== plateNumber) return previous;
      const currentTags = Array.isArray(previous.tags) ? previous.tags : [];
      if (currentTags.some((currentTag) => currentTag.name === tag.name)) {
        return previous;
      }
      return { ...previous, tags: [...currentTags, tag] };
    });
  };

  const handleDeleteSubmit = async () => {
    if (!activePlate || confirmNextBusy) return;
    const deletingSelectedRead = selectedImage?.id === activePlate.id;
    const result = await onDeleteRecord(activePlate.id);
    if (result?.success === false) return;
    setIsDeleteConfirmOpen(false);
    setActivePlate(null);
    if (deletingSelectedRead) {
      cancelConfirmNextFlow();
      selectedImageIdRef.current = null;
      viewerNavigationTimingRef.current = null;
      setSelectedImage(null);
      setSelectedIndex(-1);
      setPendingViewerNavigation(null);
      setPendingUnconfirmedNavigation(null);
    }
  };

  const correctionFormData = ({ replaceAlias = false } = {}) => {
    const formData = new FormData();
    formData.append("readId", correction.id);
    formData.append("oldPlateNumber", correction.plateNumber);
    formData.append("aliasSourcePlate", correction.observedPlate);
    formData.append("newPlateNumber", correction.newPlateNumber);
    formData.append("cameraName", correction.cameraName || "");
    formData.append("correctAll", correction.correctAll.toString());
    formData.append("unreviewedOnly", correction.unreviewedOnly.toString());
    formData.append("batchCameraOnly", correction.batchCameraOnly.toString());
    formData.append("rememberAlias", correction.rememberAlias.toString());
    formData.append("aliasScope", correction.aliasScope);
    formData.append("replaceAlias", replaceAlias.toString());
    formData.append("reason", correction.reason);
    formData.append("notes", correction.notes);
    return formData;
  };

  const handleCorrectSubmit = async ({ replaceAlias = false } = {}) => {
    if (!correction) return;
    setCorrectionError("");
    const result = await onCorrectPlate(correctionFormData({ replaceAlias }));
    if (!result?.success) {
      if (
        result?.code === "ALIAS_REPLACE_CONFIRMATION_REQUIRED" &&
        result?.aliasConflict
      ) {
        setAliasReplaceConflict(result.aliasConflict);
        return;
      }
      setCorrectionError(result?.error || "Unable to correct this plate read.");
      return;
    }
    setAliasReplaceConflict(null);
    if (result.warning) window.alert(result.warning);
    if (selectedImage && !result?.data?.aliasOnly) {
      setSelectedImage((prev) => ({
        ...prev,
        plateNumber: correction.newPlateNumber,
        reviewStatus: "corrected",
        validated: true,
      }));
    }
    setCorrection(null);
    setCorrectionPreview(null);
    setIsCorrectPlateOpen(false);
  };

  const handleCorrectionPreview = async () => {
    if (!correction?.correctAll) return;
    setCorrectionError("");
    const result = await onPreviewCorrection(correctionFormData());
    if (!result?.success) {
      setCorrectionError(result?.error || "Unable to preview matching reads.");
      return;
    }
    setCorrectionPreview(result.data);
  };

  const openReviewHistory = async (read) => {
    setHistoryState({ open: true, read, loading: true, entries: [], error: "" });
    const result = await onReviewHistory(read.id);
    setHistoryState((current) => ({
      ...current,
      loading: false,
      entries: result?.success ? result.data : [],
      error: result?.success ? "" : result?.error || "Unable to load review history.",
    }));
  };

  const handleReverseReview = async ({ disableAlias = false } = {}) => {
    if (!historyState.read) return;
    const formData = new FormData();
    formData.append("readId", historyState.read.id);
    formData.append("reason", "administrator_reversal");
    if (disableAlias && reverseCandidate?.related_alias_id) {
      formData.append("disableAliasId", reverseCandidate.related_alias_id);
    }
    const result = await onReverseReview(formData);
    if (!result?.success) {
      setHistoryState((current) => ({ ...current, error: result?.error || "Unable to reverse review." }));
      return;
    }
    setReverseCandidate(null);
    await openReviewHistory(historyState.read);
  };

  const requestReverseReview = () => {
    const candidate = historyState.entries.find(
      (entry) =>
        ["confirm", "correct", "reject", "reopen"].includes(entry.action) &&
        !entry.reversed
    );
    if (candidate) setReverseCandidate(candidate);
  };

  const clearFilters = () => {
    setSearchInput("");
    onUpdateFilters({
      readId: null,
      search: "",
      fuzzySearch: null,
      tag: null,
      dateFrom: null,
      dateTo: null,
      timestampFrom: null,
      timestampTo: null,
      hourFrom: null,
      hourTo: null,
      timeZone: null,
      timeFrame: null,
      dashboardMetric: null,
      camera: null,
      reviewStatus: null,
      direction: null,
      minimumSpeed: null,
      maximumSpeed: null,
    });
  };

  const formatConfidence = (confidence) => {
    if (
      confidence === null ||
      confidence === undefined ||
      isNaN(Number(confidence))
    ) {
      return "N/A";
    }

    const numericConfidence = Number(confidence); // Ensure it's a number

    if (numericConfidence.toFixed(0) == 100) {
      return "100%";
    }

    return `${numericConfidence * 100}%`; // Keep formatting consistent
  };

  const HourRangeFilter = ({ timeFormat, value = {}, onChange }) => {
    const [isOpen, setIsOpen] = useState(false);
    // Local display state - what the user actually entered
    const [displayHours, setDisplayHours] = useState({
      from: null,
      to: null,
    });

    // Generate hours based on time format
    const hours = Array.from({ length: 24 }, (_, i) => {
      if (timeFormat === 12) {
        const period = i < 12 ? "AM" : "PM";
        const hour = i === 0 ? 12 : i > 12 ? i - 12 : i;
        return { value: i, label: `${hour}${period}` };
      }
      return { value: i, label: i.toString().padStart(2, "0") + ":00" };
    });

    const getTimeRangeLabel = () => {
      if (
        typeof displayHours.from === "number" &&
        typeof displayHours.to === "number" &&
        displayHours.from >= 0 &&
        displayHours.from < 24 &&
        displayHours.to >= 0 &&
        displayHours.to < 24
      ) {
        // Always show what the user entered
        return `${hours[displayHours.from].label} - ${
          hours[displayHours.to].label
        }`;
      }
      return "Hour Range";
    };

    const handleApply = () => {
      if (
        typeof displayHours.from === "number" &&
        typeof displayHours.to === "number"
      ) {
        const tzOffset = -(new Date().getTimezoneOffset() / 60);

        // Convert to UTC for the query parameters only
        let utcFrom = (displayHours.from - tzOffset + 24) % 24;
        let utcTo = (displayHours.to - tzOffset + 24) % 24;

        // Adjust if the range spans past midnight
        if (displayHours.to < displayHours.from) {
          utcTo += 24; // Move 'to' into the next day
        }

        // Pass UTC hours for the query but maintain our local display state
        onChange({
          from: Math.floor(utcFrom),
          to: Math.floor(utcTo),
        });
        setIsOpen(false);
      }
    };

    const handleClear = () => {
      setDisplayHours({ from: null, to: null });
      onChange({ from: undefined, to: undefined });
      setIsOpen(false);
    };

    return (
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className="hidden sm:flex gap-2 dark:bg-[#161618]"
          >
            <Clock className="h-4 w-4" />
            {getTimeRangeLabel()}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-4">
          <div className="space-y-4 ">
            <div className="space-y-2">
              <h4 className="font-medium">Filter by Hour</h4>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>From</Label>
                  <Select
                    value={
                      typeof displayHours.from === "number"
                        ? displayHours.from.toString()
                        : undefined
                    }
                    onValueChange={(val) =>
                      setDisplayHours((prev) => ({
                        ...prev,
                        from: parseInt(val),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Start hour" />
                    </SelectTrigger>
                    <SelectContent>
                      {hours.map((hour) => (
                        <SelectItem
                          key={hour.value}
                          value={hour.value.toString()}
                        >
                          {hour.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>To</Label>
                  <Select
                    value={
                      typeof displayHours.to === "number"
                        ? displayHours.to.toString()
                        : undefined
                    }
                    onValueChange={(val) =>
                      setDisplayHours((prev) => ({
                        ...prev,
                        to: parseInt(val),
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="End hour" />
                    </SelectTrigger>
                    <SelectContent>
                      {hours.map((hour) => (
                        <SelectItem
                          key={hour.value}
                          value={hour.value.toString()}
                        >
                          {hour.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={handleClear}
              >
                Clear
              </Button>
              <Button
                className="flex-1"
                onClick={handleApply}
                disabled={
                  typeof displayHours.from !== "number" ||
                  typeof displayHours.to !== "number"
                }
              >
                Apply
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    );
  };

  // Mobile filter sheet content
  const MobileFilters = () => (
    <div className="space-y-6 py-4">
      <div className="space-y-2">
        <h4 className="text-sm font-medium">Filter by Tag</h4>
        <MultiSelectFilter
          ariaLabel="Filter by tags"
          allLabel="All tags"
          value={selectedTags}
          options={tagFilterOptions}
          exclusiveValues={["untagged"]}
          onChange={handleTagChange}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Filter by Camera</h4>
        <MultiSelectFilter
          ariaLabel="Filter by cameras"
          allLabel="All cameras"
          value={selectedCameras}
          options={cameraFilterOptions}
          onChange={handleCameraChange}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Filter by Review Status</h4>
        <MultiSelectFilter
          ariaLabel="Filter by review status"
          allLabel="All review statuses"
          value={selectedReviewStatuses}
          options={reviewStatusFilterOptions}
          onChange={handleReviewStatusChange}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Filter by Direction</h4>
        <MultiSelectFilter
          ariaLabel="Filter by direction"
          allLabel="All directions"
          value={selectedDirections}
          options={directionFilterOptions}
          onChange={handleDirectionChange}
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Filter by Speed (mph)</h4>
        <div className="grid grid-cols-2 gap-2">
          <Input key={`minimum-${filters.minimumSpeed || ""}`} type="number" min="0" max="200" step="1" defaultValue={filters.minimumSpeed} placeholder="Minimum" onBlur={(event) => applySpeedFilter("minimumSpeed", event.target.value)} />
          <Input key={`maximum-${filters.maximumSpeed || ""}`} type="number" min="0" max="200" step="1" defaultValue={filters.maximumSpeed} placeholder="Maximum" onBlur={(event) => applySpeedFilter("maximumSpeed", event.target.value)} />
        </div>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Date Range</h4>
        <LiveFeedDateRangeFilter
          embedded
          value={filters.dateRange}
          onChange={handleDateRangeChange}
        />
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Hour Range</h4>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">From</Label>
            <Select
              value={filters.hourRange?.from?.toString()}
              onValueChange={(val) =>
                onUpdateFilters({
                  hourFrom: val,
                  hourTo: filters.hourRange?.to?.toString(),
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Start hour" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => {
                  const period = i < 12 ? "AM" : "PM";
                  const hour = i === 0 ? 12 : i > 12 ? i - 12 : i;
                  return (
                    <SelectItem key={i} value={i.toString()}>
                      {timeFormat === 12
                        ? `${hour}${period}`
                        : `${i.toString().padStart(2, "0")}:00`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">To</Label>
            <Select
              value={filters.hourRange?.to?.toString()}
              onValueChange={(val) =>
                onUpdateFilters({
                  hourFrom: filters.hourRange?.from?.toString(),
                  hourTo: val,
                })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="End hour" />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, i) => {
                  const period = i < 12 ? "AM" : "PM";
                  const hour = i === 0 ? 12 : i > 12 ? i - 12 : i;
                  return (
                    <SelectItem key={i} value={i.toString()}>
                      {timeFormat === 12
                        ? `${hour}${period}`
                        : `${i.toString().padStart(2, "0")}:00`}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Other Options</h4>
        <div className="space-y-2 border rounded-md p-3">
          <Label htmlFor="mobile-match-mode">Plate matching</Label>
          <PlateMatchModeSelect
            id="mobile-match-mode"
            value={filters.matchMode}
            onValueChange={handleMatchModeChange}
            settings={matchingSettings}
          />
          <p className="text-xs text-muted-foreground">
            Choose how closely plate characters must match.
          </p>
        </div>

      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Results Per Page</h4>
        <Select
          value={pagination.pageSize.toString()}
          onValueChange={handlePageSizeChange}
        >
          <SelectTrigger>
            <SelectValue>{pagination.pageSize}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {[10, 25, 50, 100, 250, 500].map((size) => (
              <SelectItem key={size} value={size.toString()}>
                {size} results per page{size === 500 ? " (large)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="pt-4 flex space-x-2">
        <Button
          variant="outline"
          className="flex-1"
          onClick={() => {
            clearFilters();
            setIsFilterSheetOpen(false);
          }}
        >
          Clear Filters
        </Button>
        <Button className="flex-1" onClick={() => setIsFilterSheetOpen(false)}>
          Apply Filters
        </Button>
      </div>
    </div>
  );

  const correctionChangesPlate = Boolean(
    correction?.newPlateNumber &&
      correction.newPlateNumber.trim().toUpperCase() !==
        String(correction.plateNumber || "").trim().toUpperCase()
  );
  const aliasOnlyCorrection = Boolean(
    correction?.rememberAlias && correction?.newPlateNumber && !correctionChangesPlate
  );

  const selectedVehicleImageAttemptLimit = selectedImage?.vehicleImageQueueKind === "overview" ? 2 : 3;
  const selectedVehicleImageManualRetryEligible = Boolean(selectedImage?.vehicleImageRetryable)
    || [
      "OVERVIEW_PROFILE_NOT_CONFIGURED",
      "OVERVIEW_PROFILE_AMBIGUOUS",
      "OVERVIEW_CAMERA_BINDING_INVALID",
      "OVERVIEW_CAMERA_BINDING_MISMATCH",
      "CAMERA_NOT_MAPPED",
    ].includes(selectedImage?.vehicleImageErrorCode);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="">
        <div className="py-4">
          <div className="mb-4 rounded-lg border bg-card p-4 shadow-sm">
            <div className="flex items-center gap-4">
              <button
                type="button"
                className="flex flex-1 items-center justify-between gap-3 rounded-md text-left"
                aria-expanded={isSearchOptionsOpen}
                aria-controls="recognition-feed-search-options"
                onClick={() =>
                  setIsSearchOptionsOpen((current) => !current)
                }
              >
                <span>
                  <span className="block font-semibold">Search options</span>
                  <span className="block text-sm text-muted-foreground">
                    Plate search, matching, and filters
                  </span>
                </span>
                <ChevronDown
                  className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${
                    isSearchOptionsOpen ? "rotate-180" : ""
                  }`}
                  aria-hidden="true"
                />
              </button>

              <div className="flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 dark:bg-[#161618]">
                <Switch
                  checked={isLive}
                  onCheckedChange={onLiveChange}
                  id="live-updates"
                />
                <Label
                  htmlFor="live-updates"
                  className="cursor-pointer text-sm"
                >
                  Live updates
                </Label>
              </div>
            </div>

            {isSearchOptionsOpen && (
              <div
                id="recognition-feed-search-options"
                className="mt-4 border-t pt-4"
              >
                {/* Search and Filters section - Desktop and Mobile */}
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex w-full flex-wrap items-start sm:items-center gap-2">
            {/* Search bar - Full Width on Mobile */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
              <div className="flex items-center w-full sm:w-auto">
                <Input
                  placeholder="Search plates or speed..."
                  icon={
                    <Search className="text-gray-400 dark:text-gray-500 absolute left-1.5 top-1/2 transform -translate-y-1/2 h-4 w-4" />
                  }
                  value={searchInput}
                  onChange={handleSearchChange}
                  className="w-full sm:w-64 h-9 dark:bg-[#161618]"
                />

                {/* Mobile Filter Button */}
                <Sheet
                  open={isFilterSheetOpen}
                  onOpenChange={setIsFilterSheetOpen}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SheetTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Open filters"
                          className="ml-2 sm:hidden h-9 w-9 dark:bg-[#161618]"
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                      </SheetTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Open filters</TooltipContent>
                  </Tooltip>
                  <SheetContent
                    side="bottom"
                    className="h-[80vh] px-4 pt-0 pb-8 overflow-y-auto"
                  >
                    <SheetHeader className="sticky top-0 bg-background pt-4 pb-2 z-10">
                      <SheetTitle>Filter Results</SheetTitle>
                    </SheetHeader>
                    <MobileFilters />
                  </SheetContent>
                </Sheet>
              </div>

              {/* Plate matching - Desktop only */}
              <div className="hidden w-[310px] sm:block">
                <PlateMatchModeSelect
                  id="match-mode"
                  value={filters.matchMode}
                  onValueChange={handleMatchModeChange}
                  settings={matchingSettings}
                  prefixLabel="Plate matching"
                  ariaLabel="Plate matching"
                  className="h-9 dark:bg-[#161618]"
                />
              </div>
            </div>

            {/* Desktop Filters */}
            <div className="hidden sm:flex flex-wrap gap-2">
              <MultiSelectFilter
                ariaLabel="Filter by tags"
                allLabel="All tags"
                value={selectedTags}
                options={tagFilterOptions}
                exclusiveValues={["untagged"]}
                onChange={handleTagChange}
                className="h-9 w-[180px] dark:bg-[#161618]"
              />
              <MultiSelectFilter
                ariaLabel="Filter by cameras"
                allLabel="All cameras"
                value={selectedCameras}
                options={cameraFilterOptions}
                onChange={handleCameraChange}
                className="h-9 w-[180px] dark:bg-[#161618]"
              />
              <MultiSelectFilter
                ariaLabel="Filter by review status"
                allLabel="All review statuses"
                value={selectedReviewStatuses}
                options={reviewStatusFilterOptions}
                onChange={handleReviewStatusChange}
                className="h-9 w-[210px] dark:bg-[#161618]"
              />
              <MultiSelectFilter
                ariaLabel="Filter by direction"
                allLabel="All directions"
                value={selectedDirections}
                options={directionFilterOptions}
                onChange={handleDirectionChange}
                className="h-9 w-[190px] dark:bg-[#161618]"
              />
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-9 gap-2 dark:bg-[#161618]">
                    Speed{filters.minimumSpeed || filters.maximumSpeed
                      ? `: ${filters.minimumSpeed || "0"}–${filters.maximumSpeed || "200"} mph`
                      : ""}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-4">
                  <div className="space-y-3">
                    <div className="text-sm font-medium">Speed range (mph)</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input key={`minimum-${filters.minimumSpeed || ""}`} type="number" min="0" max="200" step="1" defaultValue={filters.minimumSpeed} placeholder="Minimum" onBlur={(event) => applySpeedFilter("minimumSpeed", event.target.value)} />
                      <Input key={`maximum-${filters.maximumSpeed || ""}`} type="number" min="0" max="200" step="1" defaultValue={filters.maximumSpeed} placeholder="Maximum" onBlur={(event) => applySpeedFilter("maximumSpeed", event.target.value)} />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>

              <LiveFeedDateRangeFilter
                value={filters.dateRange}
                onChange={handleDateRangeChange}
              />

              <HourRangeFilter
                timeFormat={timeFormat}
                value={filters.hourRange || {}}
                onChange={(hourRange) =>
                  onUpdateFilters({
                    hourFrom:
                      typeof hourRange.from === "number"
                        ? hourRange.from.toString()
                        : undefined,
                    hourTo:
                      typeof hourRange.to === "number"
                        ? hourRange.to.toString()
                        : undefined,
                  })
                }
              />
              {(filters.readId ||
                filters.search ||
                selectedTags.length > 0 ||
                selectedDirections.length > 0 ||
                filters.minimumSpeed ||
                filters.maximumSpeed ||
                filters.dashboardTimeFrame ||
                filters.dashboardMetric ||
                filters.dateRange.from ||
                (filters.hourRange?.from !== undefined &&
                  filters.hourRange?.to !== undefined)) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  className="gap-2"
                >
                  <X className="h-4 w-4" />
                  Clear Filters
                </Button>
              )}
            </div>
          </div>

          {/* Results per page - Desktop only */}
          <div className="hidden sm:flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show</span>
            <Select
              value={pagination.pageSize.toString()}
              onValueChange={handlePageSizeChange}
            >
              <SelectTrigger className="w-[6rem] dark:bg-[#161618]">
                <SelectValue>{pagination.pageSize}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {[10, 25, 50, 100, 250, 500].map((size) => (
                  <SelectItem key={size} value={size.toString()}>
                    {size}{size === 500 ? " (large)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground text-nowrap">
              per page
            </span>
          </div>
                </div>
              </div>
            )}
          </div>

          <ResultsPagination
            position="top"
            page={pagination.page}
            pageSize={pagination.pageSize}
            total={pagination.total}
            onPreviousPage={pagination.onPreviousPage}
            onNextPage={pagination.onNextPage}
          />

        {/* Active filters display */}
        {(filters.readId ||
          filters.search ||
          selectedTags.length > 0 ||
          filters.dateRange.from ||
          selectedCameras.length > 0 ||
          selectedReviewStatuses.length > 0 ||
          selectedDirections.length > 0 ||
          filters.minimumSpeed ||
          filters.maximumSpeed ||
          filters.dashboardTimeFrame ||
          filters.dashboardMetric ||
          (filters.hourRange?.from !== undefined &&
            filters.hourRange?.to !== undefined)) && (
          <div className="flex items-center gap-2 overflow-x-auto pb-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              Active filters:
            </span>

            {filters.readId && (
              <Badge
                variant="outline"
                className="h-6 whitespace-nowrap text-xs"
              >
                Exact read: {filters.readId}
              </Badge>
            )}

            {filters.search && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Search: {filters.search}
              </Badge>
            )}

            {filters.dashboardTimeFrame && (
              <Badge
                variant="outline"
                className="h-6 whitespace-nowrap text-xs"
              >
                Dashboard: {DASHBOARD_TIME_FRAME_LABELS[filters.dashboardTimeFrame]}
              </Badge>
            )}

            {filters.dashboardMetric && (
              <Badge
                variant="outline"
                className="h-6 whitespace-nowrap text-xs"
              >
                Results: {DASHBOARD_FEED_METRIC_LABELS[filters.dashboardMetric]}
              </Badge>
            )}

            {selectedTags.length > 0 && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Tags: {selectedTags.join(", ")}
              </Badge>
            )}

            {selectedCameras.length > 0 && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Cameras: {selectedCameras.join(", ")}
              </Badge>
            )}

            {selectedReviewStatuses.length > 0 && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Review: {selectedReviewStatuses
                  .map((status) => REVIEW_STATUS_LABELS[status] || status)
                  .join(", ")}
              </Badge>
            )}

            {selectedDirections.length > 0 && (
              <Badge variant="outline" className="text-xs h-6 whitespace-nowrap">
                Direction: {selectedDirections
                  .map((direction) => direction === "__unknown__" ? "Unknown" : direction)
                  .join(", ")}
              </Badge>
            )}

            {(filters.minimumSpeed || filters.maximumSpeed) && (
              <Badge variant="outline" className="text-xs h-6 whitespace-nowrap">
                Speed: {filters.minimumSpeed || "0"}–{filters.maximumSpeed || "200"} mph
              </Badge>
            )}

            {filters.dateRange.from && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Date: {format(filters.dateRange.from, "MMM d")}
                {filters.dateRange.to &&
                  ` - ${format(filters.dateRange.to, "MMM d")}`}
              </Badge>
            )}

            {filters.hourRange?.from !== undefined &&
              filters.hourRange?.to !== undefined && (
                <Badge
                  variant="outline"
                  className="text-xs h-6 whitespace-nowrap"
                >
                  Hours: {filters.hourRange.from} - {filters.hourRange.to}
                </Badge>
              )}
          </div>
        )}

        {/* Table - Desktop view and Mobile cards */}
        <div className="rounded-md border dark:bg-[#0e0e10]">
          {/* Desktop Table */}
          <div className="hidden sm:block">
            <Table>
              <TableHeader className="dark:bg-[#161618]">
                <TableRow>
                  <TableHead className="w-24">Image</TableHead>
                  <TableHead className="w-28 sm:w-16">
                    <SortButton
                      label="Plate Number"
                      field="plate_number"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-28 hidden sm:table-cell">
                    <SortButton
                      label="%"
                      field="confidence"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-24 hidden sm:table-cell">
                    <SortButton
                      label="Occurrences"
                      field="occurrence_count"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-18 sm:w-40">
                    <SortButton
                      label="Tags"
                      field="tags"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-32 hidden sm:table-cell">
                    <SortButton
                      label="Camera"
                      field="camera_name"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-36 hidden md:table-cell">
                    <SortButton
                      label="Direction"
                      field="direction"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-24 hidden md:table-cell">
                    <SortButton label="Speed" field="speed" sort={sort} onSort={onSort} />
                  </TableHead>
                  <TableHead className="w-24 sm:w-40">
                    <SortButton
                      label="Timestamp"
                      field="timestamp"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="hidden w-px whitespace-nowrap px-2 text-right sm:table-cell">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-4">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-4">
                      No results found
                    </TableCell>
                  </TableRow>
                ) : (
                  data.map((plate, plateIndex) => (
                    <TableRow key={plate.id}>
                      <TableCell>
                        <PlateImage
                          plate={plate}
                          onClick={(e) => handleImageClick(e, plate)}
                          priority={plateIndex < 3}
                          className=""
                        />
                      </TableCell>
                      <TableCell
                        className={`font-medium font-mono ${
                          plate.flagged && "text-[#F31260]"
                        }`}
                      >
                        <PlateIdentity plate={plate} />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {formatConfidence(plate.confidence)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {plate.occurrence_count}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {plate.tags?.length > 0 ? (
                            plate.tags.map((tag) => (
                              <Badge
                                key={tag.name}
                                variant="secondary"
                                className="text-xs py-0.5 pl-2 pr-1 flex items-center space-x-1"
                                style={{
                                  backgroundColor: tag.color,
                                  color: "#fff",
                                }}
                              >
                                <span>{tag.name}</span>
                                {canManageTags && <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-4 w-4 p-0 hover:bg-red-500 hover:text-white rounded-full"
                                      aria-label={`Remove ${tag.name} tag from ${plate.plate_number}`}
                                      onClick={() =>
                                        onRemoveTag(
                                          plate.plate_number,
                                          tag.name
                                        )
                                      }
                                    >
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </TooltipTrigger>
                                  <TooltipContent>Remove tag</TooltipContent>
                                </Tooltip>}
                              </Badge>
                            ))
                          ) : (
                            <div className="text-sm text-gray-500 dark:text-gray-400 italic">
                              No tags
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {plate.camera_name || (
                          <span className="text-sm text-gray-500 dark:text-gray-400 italic">
                            Unknown
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <DirectionBadge plate={plate} />
                      </TableCell>
                      <TableCell className="hidden whitespace-nowrap md:table-cell">
                        {formatSpeed(plate.speed_mph)}
                      </TableCell>
                      <TableCell className="text-xs sm:text-sm">
                        <PlateTimestamp
                          timestamp={plate.timestamp}
                          timeFormat={timeFormat}
                        />
                      </TableCell>

                      <TableCell className="hidden w-px whitespace-nowrap px-2 sm:table-cell">
                        <div className="flex justify-end gap-0.5">
                          {canManageTags && <DropdownMenu>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className={TABLE_ACTION_BUTTON_CLASS}
                                    aria-label={`Add tag to ${plate.plate_number}`}
                                  >
                                    <Tag className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>Add tag</TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent>
                              {availableTags.map((tag) => (
                                <DropdownMenuItem
                                  key={tag.name}
                                  onClick={() =>
                                    onAddTag(plate.plate_number, tag.name)
                                  }
                                >
                                  <div className="flex items-center">
                                    <div
                                      className="w-3 h-3 rounded-full mr-2"
                                      style={{ backgroundColor: tag.color }}
                                    />
                                    {tag.name}
                                  </div>
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>}
                          {canManageKnownPlates && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={TABLE_ACTION_BUTTON_CLASS}
                                aria-label={`Add ${plate.plate_number} to known plates`}
                                onClick={() => {
                                  setActivePlate(plate);
                                  setIsAddKnownPlateOpen(true);
                                }}
                              >
                                <Plus className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Add to known plates</TooltipContent>
                          </Tooltip>}
                          {canReview && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={TABLE_ACTION_BUTTON_CLASS}
                                aria-label={`Correct plate ${plate.plate_number}`}
                                onClick={() => {
                                  setCorrection(correctionDraft({
                                    id: plate.id,
                                    plateNumber: plate.plate_number,
                                    observedPlate: plate.observed_plate || plate.plate_number,
                                    cameraName: plate.camera_name || "",
                                    image: correctionImageFromRead(plate),
                                  }));
                                  setIsCorrectPlateOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Correct plate</TooltipContent>
                          </Tooltip>}
                          {canRead && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={TABLE_ACTION_BUTTON_CLASS}
                                aria-label={`Review history for ${plate.plate_number}`}
                                onClick={() => openReviewHistory(plate)}
                              >
                                <History className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Review history</TooltipContent>
                          </Tooltip>}
                          {biHost && buildBlueIrisPlatePlaybackPath(
                            plate.bi_path,
                            plate.plate_bi_camera,
                            plate.timestamp,
                          ) ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className={TABLE_ACTION_BUTTON_CLASS}
                                  aria-label={`Open ${plate.plate_number} in Blue Iris`}
                                  onClick={() =>
                                    window.open(
                                      buildBlueIrisUiUrl(
                                        biHost,
                                        buildBlueIrisPlatePlaybackPath(
                                          plate.bi_path,
                                          plate.plate_bi_camera,
                                          plate.timestamp,
                                        ),
                                      ),
                                      "_blank"
                                    )
                                  }
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open in Blue Iris</TooltipContent>
                            </Tooltip>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="inline-flex"
                                  tabIndex={0}
                                  role="button"
                                  aria-disabled="true"
                                  aria-label="Blue Iris link unavailable"
                                >
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className={TABLE_ACTION_BUTTON_CLASS}
                                    aria-label="Blue Iris link unavailable"
                                    disabled
                                  >
                                    <ExternalLink className="h-4 w-4" />
                                  </Button>
                                </span>
                              </TooltipTrigger>
                              <TooltipContent>
                                Blue Iris link unavailable
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {canViewAudit && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={TABLE_ACTION_BUTTON_CLASS}
                                asChild
                              >
                                <Link
                                  href={`/logs?readId=${plate.id}&expand=first`}
                                  aria-label={`View logs for read ${plate.id}`}
                                >
                                  <ScrollText className="h-4 w-4" />
                                </Link>
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>View logs for this read</TooltipContent>
                          </Tooltip>}

                          {canDelete && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className={`${TABLE_ACTION_BUTTON_CLASS} text-red-500 hover:text-red-700`}
                                aria-label={`Delete record for ${plate.plate_number}`}
                                onClick={() => {
                                  setActivePlate(plate);
                                  setIsDeleteConfirmOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete record</TooltipContent>
                          </Tooltip>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Mobile Card View */}
          <div className="sm:hidden">
            {loading ? (
              <div className="p-4 text-center">Loading...</div>
            ) : data.length === 0 ? (
              <div className="p-4 text-center">No results found</div>
            ) : (
              <div className="divide-y">
                {data.map((plate, plateIndex) => (
                  <div key={plate.id} className="p-3">
                    <div className="flex items-start gap-3">
                      {/* Image and basic info */}
                      <div className="flex-shrink-0" style={{ width: "80px" }}>
                        <PlateImage
                          plate={plate}
                          onClick={(e) => handleImageClick(e, plate)}
                          priority={plateIndex < 3}
                        />
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Top row - Plate number and actions */}
                        <div className="flex justify-between items-start mb-1">
                          <div>
                            <div
                              className={`font-medium font-mono text-sm ${
                                plate.flagged && "text-[#F31260]"
                              }`}
                            >
                              <PlateIdentity plate={plate} compact />
                            </div>
                          </div>

                          {/* Mobile actions dropdown */}
                          {(canRead || canManageKnownPlates || canReview || canDelete || (biHost && plate.bi_path)) && <DropdownMenu>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8"
                                    aria-label={`More actions for ${plate.plate_number}`}
                                  >
                                    <MoreHorizontal className="h-4 w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                              </TooltipTrigger>
                              <TooltipContent>More actions</TooltipContent>
                            </Tooltip>
                            <DropdownMenuContent align="end">
                              {canManageKnownPlates && <DropdownMenuItem
                                onClick={() => {
                                  setActivePlate(plate);
                                  setIsAddKnownPlateOpen(true);
                                }}
                              >
                                <Plus className="h-4 w-4 mr-2" />
                                Add to Known Plates
                              </DropdownMenuItem>}
                              {canReview && <DropdownMenuItem
                                onClick={() => {
                                  setCorrection(correctionDraft({
                                    id: plate.id,
                                    plateNumber: plate.plate_number,
                                    observedPlate: plate.observed_plate || plate.plate_number,
                                    cameraName: plate.camera_name || "",
                                    image: correctionImageFromRead(plate),
                                  }));
                                  setIsCorrectPlateOpen(true);
                                }}
                              >
                                <Pencil className="h-4 w-4 mr-2" />
                                Correct Plate
                              </DropdownMenuItem>}
                              {canRead && <DropdownMenuItem onClick={() => openReviewHistory(plate)}>
                                <History className="h-4 w-4 mr-2" />
                                Review History
                              </DropdownMenuItem>}
                              {biHost && buildBlueIrisPlatePlaybackPath(
                                plate.bi_path,
                                plate.plate_bi_camera,
                                plate.timestamp,
                              ) ? (
                                <DropdownMenuItem
                                  onClick={() =>
                                    window.open(
                                      buildBlueIrisUiUrl(
                                        biHost,
                                        buildBlueIrisPlatePlaybackPath(
                                          plate.bi_path,
                                          plate.plate_bi_camera,
                                          plate.timestamp,
                                        ),
                                      ),
                                      "_blank"
                                    )
                                  }
                                >
                                  <ExternalLink className="h-4 w-4 mr-2" />
                                  Open in Blue Iris
                                </DropdownMenuItem>
                              ) : null}
                              {canDelete && <DropdownMenuItem
                                className="text-red-500"
                                onClick={() => {
                                  setActivePlate(plate);
                                  setIsDeleteConfirmOpen(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete Record
                              </DropdownMenuItem>}
                            </DropdownMenuContent>
                          </DropdownMenu>}
                        </div>

                        {/* Middle row - Tags */}
                        <div className="mb-2">
                          {plate.tags?.length > 0 ? (
                            <div className="flex flex-wrap gap-1 mb-1">
                              {plate.tags.map((tag) => (
                                <Badge
                                  key={tag.name}
                                  variant="secondary"
                                  className="text-[10px] py-0.5 pl-1.5 pr-1 flex items-center gap-1"
                                  style={{
                                    backgroundColor: tag.color,
                                    color: "#fff",
                                  }}
                                >
                                  <span>{tag.name}</span>
                                  {canManageTags && <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-3 w-3 p-0 hover:bg-red-500 hover:text-white rounded-full"
                                        aria-label={`Remove ${tag.name} tag from ${plate.plate_number}`}
                                        onClick={() =>
                                          onRemoveTag(
                                            plate.plate_number,
                                            tag.name
                                          )
                                        }
                                      >
                                        <X className="h-2 w-2" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>Remove tag</TooltipContent>
                                  </Tooltip>}
                                </Badge>
                              ))}

                              {/* Add tag button */}
                              {canManageTags && <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-5 text-[10px] px-1.5"
                                  >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Tag
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  {availableTags.map((tag) => (
                                    <DropdownMenuItem
                                      key={tag.name}
                                      onClick={() =>
                                        onAddTag(plate.plate_number, tag.name)
                                      }
                                    >
                                      <div className="flex items-center">
                                        <div
                                          className="w-3 h-3 rounded-full mr-2"
                                          style={{ backgroundColor: tag.color }}
                                        />
                                        {tag.name}
                                      </div>
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <span className="text-xs text-muted-foreground">
                                No tags
                              </span>
                              {canManageTags && <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-5 text-[10px] px-1.5"
                                  >
                                    <Plus className="h-3 w-3 mr-1" />
                                    Tag
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent>
                                  {availableTags.map((tag) => (
                                    <DropdownMenuItem
                                      key={tag.name}
                                      onClick={() =>
                                        onAddTag(plate.plate_number, tag.name)
                                      }
                                    >
                                      <div className="flex items-center">
                                        <div
                                          className="w-3 h-3 rounded-full mr-2"
                                          style={{ backgroundColor: tag.color }}
                                        />
                                        {tag.name}
                                      </div>
                                    </DropdownMenuItem>
                                  ))}
                                </DropdownMenuContent>
                              </DropdownMenu>}
                            </div>
                          )}
                        </div>

                        {/* Bottom row - Camera, confidence, time */}
                        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                          <div>
                            <span className="font-medium">Camera: </span>
                            {plate.camera_name || "Unknown"}
                          </div>
                          <div>
                            <span className="font-medium">Confidence: </span>
                            {formatConfidence(plate.confidence)}
                          </div>
                          <div>
                            <span className="font-medium">Count: </span>
                            {plate.occurrence_count}
                          </div>
                          <div>
                            <span className="font-medium">Direction: </span>
                            {directionDisplayLabel(plate)}
                          </div>
                          <div>
                            <span className="font-medium">Time: </span>
                            {new Date(plate.timestamp).toLocaleTimeString(
                              "en-US",
                              {
                                hour12: timeFormat === 12,
                                hour: "numeric",
                                minute: "numeric",
                              }
                            )}
                          </div>
                          <div>
                            <span className="font-medium">Speed: </span>
                            {formatSpeed(plate.speed_mph)}
                          </div>
                          <div className="col-span-2">
                            <span className="font-medium">Date: </span>
                            {new Date(plate.timestamp).toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <ResultsPagination
          position="bottom"
          page={pagination.page}
          pageSize={pagination.pageSize}
          total={pagination.total}
          onPreviousPage={pagination.onPreviousPage}
          onNextPage={pagination.onNextPage}
        />

        {/* Modals - These work on both mobile and desktop */}
        <Dialog
          open={selectedImage !== null}
          onOpenChange={(open) => {
            if (!open) closeImageViewer();
          }}
        >
          <DialogContent
            showCloseButton={false}
            onInteractOutside={(event) => {
              if (isImageFullscreen) event.preventDefault();
            }}
            onEscapeKeyDown={(event) => {
              if (isImageFullscreen) event.preventDefault();
            }}
            className="max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-7xl gap-3 overflow-y-auto p-3 lg:h-[calc(100vh-2rem)] lg:grid-cols-[minmax(0,1fr)_11rem] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-hidden"
          >
            <DialogTitle className="sr-only">
              License Plate Image - {selectedImage?.plateNumber}
            </DialogTitle>
            {selectedImage && (
              <div className="contents">
                <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3 lg:col-start-1 lg:row-start-1">
                  <div className="grid gap-x-2 gap-y-3 rounded-lg border px-2.5 py-2 text-sm sm:grid-cols-2 md:grid-cols-5 lg:grid-cols-10">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Observed</div>
                  <Link href={`/live_feed?search=${encodeURIComponent(selectedImage.observedPlate)}&matchMode=off`} onClick={handlePlateFilterNavigation} className="font-mono text-lg font-semibold leading-tight text-blue-500 hover:underline">{selectedImage.observedPlate}</Link>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Effective</div>
                  <Link href={`/live_feed?search=${encodeURIComponent(selectedImage.plateNumber)}&matchMode=off`} onClick={handlePlateFilterNavigation} className="font-mono text-lg font-semibold leading-tight text-blue-500 hover:underline">{selectedImage.plateNumber}</Link>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Review status</div>
                  <div>{REVIEW_STATUS_LABELS[selectedImage.reviewStatus] || selectedImage.reviewStatus}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Count</div>
                  <div>{selectedImage.occurrenceCount ?? "—"}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Camera</div>
                  <div className={selectedImage.cameraName ? "" : "text-muted-foreground"}>
                    {selectedImage.cameraName || "Unknown"}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Known plate</div>
                  <div className={selectedImage.knownName ? "" : "text-muted-foreground"}>
                    {selectedImage.knownName || "Not known"}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Tags</div>
                  {selectedImage.tags?.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {selectedImage.tags.map((tag) => (
                        <Badge
                          key={tag.name}
                          variant="secondary"
                          className="px-2 py-0 text-xs text-white"
                          style={{ backgroundColor: tag.color }}
                        >
                          {tag.name}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-muted-foreground">No tags</div>
                  )}
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Time</div>
                  <PlateTimestamp timestamp={selectedImage.timestamp} timeFormat={timeFormat} />
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Speed</div>
                  <div>{formatSpeed(selectedImage.speedMph)}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Vehicle</div>
                  {selectedImage.vehicleClusterId ? (
                    <Link
                      href={selectedImage.vehicleIdentityMode === "v2_primary"
                        ? `/visual_search/profiles/${selectedImage.vehicleClusterId}`
                        : `/visual_search/vehicles/${selectedImage.vehicleClusterId}`}
                      className="text-blue-500 hover:underline"
                    >
                      {selectedImage.vehicleIdentityMode === "v2_primary"
                        ? `Vehicle #${selectedImage.vehicleClusterId}`
                        : `Legacy Vehicle #${selectedImage.vehicleClusterId}`}
                    </Link>
                  ) : (
                    <div className="text-muted-foreground">
                      {selectedImage.vehicleIdentityMode === "v2_primary"
                        ? "Unassigned in ReID"
                        : "Unassigned in legacy ReID v1"}
                    </div>
                  )}
                </div>
                  </div>
                  <div className="relative h-[40vh] w-full overflow-hidden rounded-md border bg-black sm:h-auto sm:min-h-0">
                    {selectedImage.vehicleImageUrl && (
                      <div className="absolute left-2 top-2 z-20 flex flex-col rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur">
                        <Button type="button" size="sm" variant={displayedImageView === "plate" ? "default" : "ghost"} className="h-7 justify-start px-2 text-xs" onClick={() => handleSelectedImageViewChange("plate")}>Plate capture</Button>
                        <Button type="button" size="sm" variant={displayedImageView === "vehicle" ? "default" : "ghost"} className="h-7 justify-start px-2 text-xs" onClick={() => handleSelectedImageViewChange("vehicle")}>Vehicle view</Button>
                      </div>
                    )}
                    {!selectedImage.vehicleImageUrl && selectedImage.vehicleImageStatus && (
                      <div className="absolute left-2 top-2 z-20 max-w-[min(26rem,calc(100%-1rem))] space-y-2 rounded-md border bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
                        <div>
                          Vehicle view: {{
                            pending: selectedImage.vehicleImageErrorCode === "WAITING_FOR_DAYTIME_OVERVIEW"
                              ? "Queued for daytime overview"
                              : "Queued",
                            processing: "Processing",
                            failed: selectedImage.vehicleImageRetryable
                              && selectedImage.vehicleImageAttemptCount < selectedVehicleImageAttemptLimit
                              ? `Retry pending (attempt ${selectedImage.vehicleImageAttemptCount} of ${selectedVehicleImageAttemptLimit})`
                              : ({
                                  OVERVIEW_PROCESSING_DEADLINE: `Processing deadline exceeded after ${selectedImage.vehicleImageAttemptCount || selectedVehicleImageAttemptLimit} attempts`,
                                  EXPORT_START_UNCERTAIN: "Blue Iris export ownership could not be verified safely",
                                }[selectedImage.vehicleImageErrorCode]
                                  || `Failed after ${selectedImage.vehicleImageAttemptCount || selectedVehicleImageAttemptLimit} attempts`),
                            unavailable: {
                              RECORDING_UNAVAILABLE: "Recording unavailable or expired",
                              VEHICLE_NOT_VISIBLE: "No complete vehicle was found in the available Vehicle View window",
                              CAMERA_NOT_MAPPED: "Camera not mapped in Blue Iris",
                              OVERVIEW_PROFILE_NOT_CONFIGURED: "No overview profile was configured for this camera and direction",
                              OVERVIEW_PROFILE_AMBIGUOUS: "Multiple overview profiles match this camera and direction",
                              OVERVIEW_CAMERA_BINDING_INVALID: "The overview profile is missing its Blue Iris short-name binding",
                              OVERVIEW_CAMERA_BINDING_MISMATCH: "The overview camera does not match its reviewed Blue Iris binding",
                              NIGHTTIME_UNAVAILABLE: "Unavailable nighttime",
                              DAYLIGHT_UNVERIFIED: "Unavailable because daylight could not be verified",
                              OVERVIEW_DIRECTION_UNAVAILABLE: "Unavailable because Blue Iris did not provide a validated direction",
                              NO_MATCHING_PLATE_READ: "No matching daytime overview was found",
                              NO_MATCHING_DAYTIME_OVERVIEW: "No matching daytime overview was found",
                              MULTIPLE_VEHICLES_MATCH: "Multiple vehicles could match; no image was assigned",
                              MULTIPLE_VEHICLES_VISIBLE: "Multiple vehicles were visible at the expected time; no image was assigned",
                              EXPORT_RESOLUTION_TOO_LOW: "Blue Iris export was below the configured minimum resolution",
                              EXPORT_TIMELINE_UNVERIFIED: "Blue Iris did not provide exact UTC export timing",
                              EXPORT_TIMELINE_MISMATCH: "Blue Iris export did not cover the requested timeline",
                              MEDIA_TOOL_UNAVAILABLE: "Vehicle View media tools are unavailable",
                              CANDIDATE_IMAGE_MISSING: "The selected overview image is no longer available",
                            }[selectedImage.vehicleImageErrorCode] || "Unavailable",
                          }[selectedImage.vehicleImageStatus] || selectedImage.vehicleImageStatus}
                        </div>
                        {canReview
                          && selectedVehicleImageManualRetryEligible
                          && selectedImage.vehicleImageAttemptCount < selectedVehicleImageAttemptLimit
                          && ["failed", "unavailable"].includes(selectedImage.vehicleImageStatus) ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            disabled={pendingVehicleImageRetry || confirmNextBusy}
                            onClick={handleVehicleImageRetry}
                          >
                            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                            {pendingVehicleImageRetry ? "Queueing..." : "Retry vehicle view"}
                          </Button>
                        ) : null}
                        {vehicleImageRetryError ? (
                          <div className="text-destructive">{vehicleImageRetryError}</div>
                        ) : null}
                      </div>
                    )}
                    <ImageViewer
                      image={{
                        ...selectedImage,
                        url: displayedImageView === "vehicle"
                          ? selectedImage.vehicleImageUrl
                          : selectedImage.plateCaptureUrl,
                        crop_coordinates: displayedImageView === "vehicle" ? null : selectedImage.crop_coordinates,
                        focus_coordinates: displayedImageView === "vehicle"
                          ? selectedImage.vehicleImageDetectionBox
                          : null,
                      }}
                      zoomEnabled={displayedImageView === "vehicle"}
                      defaultZoom={null}
                      zoomLabel={displayedImageView === "vehicle" ? "Zoom to Vehicle" : "Zoom to Plate"}
                      onFullscreenChange={setIsImageFullscreen}
                      onImageLoad={handleViewerImageLoad}
                    />
                  </div>
                </div>
                <aside className="h-full rounded-lg border p-2.5 text-sm lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0">
                  <div className="flex items-center gap-1 text-xs uppercase text-muted-foreground">
                    <span>Direction</span>
                    {canReview && (
                      <Popover open={isDirectionReviewOpen} onOpenChange={setIsDirectionReviewOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-4 w-4 shrink-0 p-0 text-muted-foreground hover:text-foreground"
                            disabled={confirmNextBusy}
                            aria-label="Review vehicle direction"
                          >
                            <Pencil className="h-2.5 w-2.5" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 p-3">
                          <div className="space-y-3">
                            <div>
                              <div className="text-sm font-medium">Review vehicle direction</div>
                              <div className="text-xs text-muted-foreground">
                                Choose the view shown in this capture.
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                type="button"
                                variant={selectedImage.vehicleOrientation === "front" ? "default" : "outline"}
                                size="sm"
                                disabled={Boolean(pendingDirectionReview) || confirmNextBusy}
                                onClick={() => handleDirectionReview("front")}
                              >
                                {pendingDirectionReview === "front" ? "Saving..." : "Front view"}
                              </Button>
                              <Button
                                type="button"
                                variant={selectedImage.vehicleOrientation === "rear" ? "default" : "outline"}
                                size="sm"
                                disabled={Boolean(pendingDirectionReview) || confirmNextBusy}
                                onClick={() => handleDirectionReview("rear")}
                              >
                                {pendingDirectionReview === "rear" ? "Saving..." : "Rear view"}
                              </Button>
                            </div>
                            {directionReviewError && (
                              <div className="text-xs text-destructive">{directionReviewError}</div>
                            )}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                    <DialogClose asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto h-6 w-6 text-muted-foreground hover:text-foreground"
                        aria-label="Close image popup"
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </DialogClose>
                  </div>
                  <div className={selectedImage.directionLabel ? "" : "text-muted-foreground"}>
                    {selectedImage.directionUnavailableReason === "monochrome_night_capture"
                      ? "Unavailable nighttime"
                      : selectedImage.directionLabel
                      || (selectedImage.directionProfileConfigured && !selectedImage.directionStatus
                        ? "Pending"
                        : "Unknown")}
                  </div>
                  {selectedImage.directionLabel && selectedImage.directionConfidence !== null ? (
                    <div className="text-xs text-muted-foreground">
                      {selectedImage.vehicleOrientation} view · {Math.round(selectedImage.directionConfidence * 100)}%
                    </div>
                  ) : null}
                  <div className="mt-4 space-y-3 border-t pt-3">
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">Type</div>
                      <div className="capitalize">
                        {selectedImage.vehicleBodyType && selectedImage.vehicleBodyTypeConfidence !== null
                          ? selectedImage.vehicleBodyType
                          : "Unavailable"}
                      </div>
                      {selectedImage.vehicleBodyType && selectedImage.vehicleBodyTypeConfidence !== null ? (
                        <div className="text-xs text-muted-foreground">
                          {Math.round(selectedImage.vehicleBodyTypeConfidence * 100)}% confidence
                        </div>
                      ) : null}
                    </div>
                    <div>
                      <div className="text-xs uppercase text-muted-foreground">Color</div>
                      <div className="capitalize">
                        {selectedImage.vehicleColor && selectedImage.vehicleColorConfidence !== null
                          ? selectedImage.vehicleColor
                          : selectedImage.vehicleColorStatus === "unknown" ? "Unavailable" : "Pending"}
                      </div>
                      {selectedImage.vehicleColor && selectedImage.vehicleColorConfidence !== null ? (
                        <div className="text-xs text-muted-foreground">
                          {Math.round(selectedImage.vehicleColorConfidence * 100)}% confidence
                        </div>
                      ) : null}
                    </div>
                  </div>
                </aside>
              </div>
            )}
            <DialogFooter className="self-end lg:col-start-1 lg:row-start-2">
              <div className="grid w-full gap-3">
                  <div className={POPUP_ACTION_GRID_CLASS}>
                    <PopupActionSlot>
                      {canRead && selectedImage && (selectedImage.vehicleIdentityMode !== "v2_primary" || selectedImage.vehicleFindSimilarAvailable) ? <Button
                        asChild
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        aria-label={selectedImage.vehicleIdentityMode === "v2_primary"
                          ? "Find similar vehicle"
                          : "Find similar using legacy ReID v1"}
                        title={selectedImage.vehicleIdentityMode === "v2_primary"
                          ? "Find similar from the exact canonical Vehicle View"
                          : "Find similar using legacy ReID v1 plate-image search"}
                      >
                        <Link href={`/visual_search?readId=${selectedImage.id}`}>
                          <ScanSearch className={POPUP_ACTION_ICON_CLASS} />
                          <span className={POPUP_ACTION_LABEL_CLASS}>
                            {selectedImage.vehicleIdentityMode === "v2_primary"
                              ? "Find similar vehicle"
                              : "Find similar (legacy v1)"}
                          </span>
                        </Link>
                      </Button> : canRead && selectedImage?.vehicleIdentityMode === "v2_primary" && selectedImage.vehicleProfileId ? (
                        <Button asChild variant="outline" size="sm" className={POPUP_ACTION_BUTTON_CLASS}>
                          <Link href={`/visual_search/profiles/${selectedImage.vehicleProfileId}`}>
                            <CarFront className={POPUP_ACTION_ICON_CLASS} />
                            <span className={POPUP_ACTION_LABEL_CLASS}>Open Vehicle Profile</span>
                          </Link>
                        </Button>
                      ) : canRead && selectedImage?.vehicleIdentityMode === "v2_primary" ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={POPUP_ACTION_BUTTON_CLASS}
                          disabled
                          title="No identity-eligible Vehicle View or authoritative profile is available"
                        >
                          <ScanSearch className={POPUP_ACTION_ICON_CLASS} />
                          <span className={POPUP_ACTION_LABEL_CLASS}>Find similar unavailable</span>
                        </Button>
                      ) : null}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canReview && selectedImage?.vehicleIdentityMode !== "v2_primary" && selectedImage?.vehicleClusterStatus === "suggested" && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        disabled={Boolean(pendingVehicleReview) || confirmNextBusy}
                        onClick={() => handleVehicleReview("confirm")}
                        aria-label="Confirm suggested legacy vehicle match"
                        title="Confirm suggested legacy ReID v1 vehicle match"
                      >
                        <CircleCheck className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Confirm legacy vehicle</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canReview && selectedImage?.vehicleIdentityMode !== "v2_primary" && selectedImage?.vehicleClusterStatus === "suggested" && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        disabled={Boolean(pendingVehicleReview) || confirmNextBusy}
                        onClick={() => handleVehicleReview("separate")}
                        aria-label="Mark as a different legacy vehicle"
                        title="Mark as a different legacy ReID v1 vehicle"
                      >
                        <Split className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Different legacy vehicle</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canReview && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        disabled={confirmNextBusy}
                        aria-label="Correct detected plate"
                        title="Correct detected plate"
                        onClick={() => {
                          setCorrection(correctionDraft({
                            id: selectedImage.id,
                            plateNumber: selectedImage.plateNumber,
                            observedPlate: selectedImage.observedPlate || selectedImage.plateNumber,
                            cameraName: selectedImage.cameraName || "",
                            image: {
                              ...selectedImage,
                              url: selectedImage.plateCaptureUrl || selectedImage.url,
                              crop_coordinates: selectedImage.crop_coordinates || null,
                            },
                          }));
                          setIsCorrectPlateOpen(true);
                        }}
                      >
                        <Edit className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Correct Plate</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canRead && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        aria-label="Open review history"
                        title="Open review history"
                        onClick={() => openReviewHistory({
                          id: selectedImage.id,
                          plate_number: selectedImage.plateNumber,
                          observed_plate: selectedImage.observedPlate,
                        })}
                      >
                        <History className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Review History</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canManageKnownPlates && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        disabled={confirmNextBusy}
                        aria-label="Add plate to Known Plates"
                        title="Add plate to Known Plates"
                        onClick={() => {
                          setActivePlate({
                            ...selectedImage,
                            plate_number: selectedImage.plateNumber,
                          });
                          setIsAddKnownPlateOpen(true);
                        }}
                      >
                        <Plus className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Add to Known</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canManageTags && <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className={POPUP_ACTION_BUTTON_CLASS}
                            disabled={confirmNextBusy}
                            aria-label="Add a tag"
                            title="Add a tag"
                          >
                            <Tag className={POPUP_ACTION_ICON_CLASS} />
                            <span className={POPUP_ACTION_LABEL_CLASS}>Add Tag</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          {availableTags.map((tag) => (
                            <DropdownMenuItem
                              key={tag.name}
                              onClick={() => handleSelectedImageAddTag(tag)}
                            >
                              <div className="flex items-center">
                                <div
                                  className="w-3 h-3 rounded-full mr-2"
                                  style={{ backgroundColor: tag.color }}
                                />
                                {tag.name}
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>}
                    </PopupActionSlot>
                  </div>
                  <div className={POPUP_ACTION_GRID_CLASS}>
                    <PopupActionSlot>
                      {canReview && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        onClick={handleConfirmAndNext}
                        disabled={!hasNextUnconfirmedRead || pendingReviewReadId === selectedImage?.id || pendingViewerNavigation !== null || confirmNextBusy}
                        aria-label="Confirm detected plate and show the next unconfirmed read"
                        title="Confirm and show next unconfirmed read"
                      >
                        <Check className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Confirm and Next</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canReview && <Button
                        variant="outline"
                        size="sm"
                        className={
                          selectedImage?.validated
                            ? `${POPUP_ACTION_BUTTON_CLASS} border-green-500/60 bg-green-500/10 text-green-500 hover:bg-green-500/20 hover:text-green-400`
                            : POPUP_ACTION_BUTTON_CLASS
                        }
                        onClick={handleSelectedImageValidation}
                        disabled={pendingReviewReadId === selectedImage?.id || pendingViewerNavigation !== null || confirmNextBusy}
                        aria-label={selectedImage?.validated ? "Reopen plate review" : "Confirm detected plate"}
                        title={selectedImage?.validated ? "Reopen plate review" : "Confirm detected plate"}
                      >
                        {selectedImage?.validated ? (
                          <CircleCheck className={POPUP_ACTION_ICON_CLASS} />
                        ) : (
                          <Check className={POPUP_ACTION_ICON_CLASS} />
                        )}
                        <span className={POPUP_ACTION_LABEL_CLASS}>
                          {pendingReviewReadId === selectedImage?.id
                            ? pendingReviewTargetValidated
                              ? "Confirming..."
                              : "Reopening..."
                            : selectedImage?.validated
                              ? "Reopen review"
                              : "Confirm detected plate"}
                        </span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        onClick={handleNextImage}
                        disabled={!hasNextImage || pendingViewerNavigation !== null || confirmNextBusy}
                        aria-label="Show next read in the filtered Live Feed results"
                        title="Show next read (Right Arrow)"
                      >
                        <span className={POPUP_ACTION_LABEL_CLASS}>Next read</span>
                        <ChevronRight className="ml-1 h-3.5 w-3.5" />
                      </Button>
                    </PopupActionSlot>
                    <PopupActionSlot>
                      {canDelete && <Button
                        variant="outline"
                        size="sm"
                        className={`${POPUP_ACTION_BUTTON_CLASS} text-red-500 hover:text-red-700`}
                        disabled={pendingViewerNavigation !== null || confirmNextBusy}
                        onClick={() => {
                          setActivePlate({
                            ...selectedImage,
                            plate_number: selectedImage.plateNumber,
                          });
                          setIsDeleteConfirmOpen(true);
                        }}
                        aria-label={`Delete read for ${selectedImage?.plateNumber}`}
                        title="Delete this read"
                      >
                        <Trash2 className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Delete</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot>
                      <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        onClick={handlePreviousImage}
                        disabled={!hasPreviousImage || pendingViewerNavigation !== null || confirmNextBusy}
                        aria-label="Show previous read in the filtered Live Feed results"
                        title="Show previous read (Left Arrow)"
                      >
                        <ChevronLeft className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Previous Read</span>
                      </Button>
                    </PopupActionSlot>
                    <PopupActionSlot reserve className="col-start-6">
                      {biHost && selectedBlueIrisPath && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        aria-label="Open recording in Blue Iris"
                        title="Open recording in Blue Iris"
                        onClick={() =>
                          window.open(
                            buildBlueIrisUiUrl(biHost, selectedBlueIrisPath),
                            "_blank"
                          )
                        }
                      >
                        <ExternalLink className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Blue Iris</span>
                      </Button>}
                    </PopupActionSlot>
                    <PopupActionSlot reserve>
                      {canExport && <Button
                        variant="outline"
                        size="sm"
                        className={POPUP_ACTION_BUTTON_CLASS}
                        onClick={handleDownloadImage}
                        aria-label="Download image"
                        title="Download image"
                      >
                        <Download className={POPUP_ACTION_ICON_CLASS} />
                        <span className={POPUP_ACTION_LABEL_CLASS}>Download</span>
                      </Button>}
                    </PopupActionSlot>
                  </div>
                </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={isAddKnownPlateOpen}
          onOpenChange={setIsAddKnownPlateOpen}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Add to Known Plates</DialogTitle>
              <DialogDescription>
                Add details for the plate {activePlate?.plate_number}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={newKnownPlate.name}
                  onChange={(e) =>
                    setNewKnownPlate({ ...newKnownPlate, name: e.target.value })
                  }
                  placeholder="Enter name"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={newKnownPlate.notes}
                  onChange={(e) =>
                    setNewKnownPlate({
                      ...newKnownPlate,
                      notes: e.target.value,
                    })
                  }
                  placeholder="Additional notes or details"
                  rows={3}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="submit"
                onClick={handleAddKnownPlateSubmit}
                className="w-full sm:w-auto"
              >
                Add to Known Plates
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={isDeleteConfirmOpen}
          onOpenChange={setIsDeleteConfirmOpen}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Confirm Deletion</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete this record? This will not
                delete the plate from the known plates table.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setIsDeleteConfirmOpen(false)}
                className="w-full sm:w-auto order-2 sm:order-1"
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={handleDeleteSubmit}
                className="w-full sm:w-auto order-1 sm:order-2"
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={correction !== null}
          onOpenChange={(open) => {
            if (!open) {
              setCorrection(null);
              setCorrectionError("");
              setCorrectionPreview(null);
            }
          }}
        >
          <DialogContent
            className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                const input = correctionInputRef.current;
                if (!input) return;
                input.focus();
                const cursorPosition = input.value.length;
                input.setSelectionRange(cursorPosition, cursorPosition);
              });
            }}
          >
            <DialogHeader>
              <DialogTitle>Correct this plate read</DialogTitle>
              <DialogDescription>
                The camera observation is preserved. Searches, known-plate details,
                tags, rules, and notifications use the effective plate.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-2">
              <div
                className={
                  correction?.image
                    ? "grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
                    : "grid gap-4"
                }
              >
                {correction?.image && (
                  <div className="grid gap-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Plate image
                    </div>
                    <div className="relative h-56 overflow-hidden rounded-lg border bg-black p-2">
                      <ImageViewer
                        image={correction.image}
                        zoomEnabled
                        compactControls
                        fitPlateOnOpen
                      />
                    </div>
                  </div>
                )}
                <div className="grid gap-4">
                  <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Camera observed
                      </div>
                      <div className="font-mono text-lg">{correction?.observedPlate}</div>
                    </div>
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        Current effective plate
                      </div>
                      <div className="font-mono text-lg">{correction?.plateNumber}</div>
                    </div>
                  </div>

                  <div className="grid gap-2">
                    <Label htmlFor="new-plate">Corrected effective plate</Label>
                    <Input
                      ref={correctionInputRef}
                      id="new-plate"
                      value={correction?.newPlateNumber || ""}
                      onChange={handleCorrectionPlateChange}
                      className="h-10 font-mono text-base uppercase"
                      placeholder="ENTER CORRECT PLATE"
                    />
                  </div>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="correction-reason">Reason</Label>
                <Select
                  value={correction?.reason || "ocr_character_error"}
                  onValueChange={(value) =>
                    setCorrection((current) => ({ ...current, reason: value }))
                  }
                >
                  <SelectTrigger id="correction-reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ocr_character_error">OCR character error</SelectItem>
                    <SelectItem value="obscured_or_blurred">Obscured or blurred plate</SelectItem>
                    <SelectItem value="partial_plate">Partial plate capture</SelectItem>
                    <SelectItem value="wrong_region_format">Wrong region or format</SelectItem>
                    <SelectItem value="manual_visual_review">Manual visual review</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="correction-notes">Review notes (optional)</Label>
                <Textarea
                  id="correction-notes"
                  value={correction?.notes || ""}
                  onChange={(event) =>
                    setCorrection((current) => ({ ...current, notes: event.target.value }))
                  }
                  maxLength={2000}
                  placeholder="Add context for the audit history"
                />
              </div>

              {canBatchReview && !aliasOnlyCorrection && (
                <div className="space-y-3 rounded-lg border p-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="correct-all"
                      checked={correction?.correctAll || false}
                      onCheckedChange={(checked) => {
                        setCorrection((current) => ({ ...current, correctAll: checked }));
                        setCorrectionPreview(null);
                      }}
                    />
                    <Label htmlFor="correct-all">Batch-correct matching effective plates</Label>
                  </div>
                  {correction?.correctAll && (
                    <div className="space-y-3 pl-1">
                      <div className="flex items-center gap-2">
                        <Switch
                          id="unreviewed-only"
                          checked={correction.unreviewedOnly}
                          onCheckedChange={(checked) => {
                            setCorrection((current) => ({ ...current, unreviewedOnly: checked }));
                            setCorrectionPreview(null);
                          }}
                        />
                        <Label htmlFor="unreviewed-only">Only currently unreviewed reads</Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          id="batch-camera-only"
                          checked={correction.batchCameraOnly}
                          onCheckedChange={(checked) => {
                            setCorrection((current) => ({ ...current, batchCameraOnly: checked }));
                            setCorrectionPreview(null);
                          }}
                        />
                        <Label htmlFor="batch-camera-only">
                          Only camera {correction.cameraName || "for this read"}
                        </Label>
                      </div>
                      <Button type="button" variant="outline" onClick={handleCorrectionPreview}>
                        Preview affected reads
                      </Button>
                      {correctionPreview && (
                        <div className="rounded-md bg-muted p-3 text-sm">
                          <div className="font-medium">
                            {correctionPreview.read_count} reads across{" "}
                            {correctionPreview.camera_count} cameras
                          </div>
                          <div className="text-muted-foreground">
                            {correctionPreview.already_reviewed} already reviewed
                            {correctionPreview.first_seen && correctionPreview.last_seen
                              ? ` · ${new Date(correctionPreview.first_seen).toLocaleString()} through ${new Date(correctionPreview.last_seen).toLocaleString()}`
                              : ""}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {canManageAliases && (
                <div className="space-y-3 rounded-lg border border-violet-500/30 p-4">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="remember-alias"
                      checked={correction?.rememberAlias || false}
                      onCheckedChange={(checked) =>
                        setCorrection((current) => ({ ...current, rememberAlias: checked }))
                      }
                    />
                    <Label htmlFor="remember-alias">
                      Remember {correction?.observedPlate} as a recurring misread
                    </Label>
                  </div>
                  {correction?.rememberAlias && (
                    <div className="grid gap-2">
                      <Label htmlFor="alias-scope">Apply the reviewed alias to</Label>
                      <Select
                        value={correction.aliasScope}
                        onValueChange={(value) =>
                          setCorrection((current) => ({ ...current, aliasScope: value }))
                        }
                      >
                        <SelectTrigger id="alias-scope" className="w-full sm:w-72">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="camera">
                            This camera only ({correction.cameraName || "unknown"})
                          </SelectItem>
                          <SelectItem value="all">All cameras</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Future exact reads of {correction.observedPlate} will resolve to{" "}
                        {correction.newPlateNumber || "the corrected plate"} and inherit its
                        known name, tags, monitored-plate state, and notification rules.
                      </p>
                      {aliasOnlyCorrection && (
                        <p className="rounded-md bg-muted p-3 text-sm">
                          This read already has that effective plate. Saving will create or
                          replace only the recurring alias; no historical reads will be changed.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {correctionError && (
                <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  {correctionError}
                </div>
              )}
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => {
                  setCorrection(null);
                  setCorrectionError("");
                  setCorrectionPreview(null);
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={() => handleCorrectSubmit()}
                disabled={
                  !correction?.newPlateNumber ||
                  (!correctionChangesPlate && !correction?.rememberAlias) ||
                  (correctionChangesPlate && correction.correctAll && !correctionPreview)
                }
              >
                {aliasOnlyCorrection
                  ? "Save recurring alias"
                  : correction?.correctAll
                    ? "Apply previewed batch"
                    : "Correct this read"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={historyState.open}
          onOpenChange={(open) =>
            setHistoryState((current) => ({ ...current, open }))
          }
        >
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Plate review history</DialogTitle>
              <DialogDescription>
                Original observations and review events are retained permanently.
              </DialogDescription>
            </DialogHeader>
            {historyState.loading ? (
              <div className="py-8 text-center text-muted-foreground">Loading review history…</div>
            ) : historyState.entries.length === 0 ? (
              <div className="rounded-lg border p-4 text-sm text-muted-foreground">
                This read has not been reviewed. The camera observation remains unchanged.
              </div>
            ) : (
              <div className="space-y-3">
                {historyState.entries.map((entry) => (
                  <div key={entry.id} className="rounded-lg border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Badge variant="outline">{entry.action.replaceAll("_", " ")}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(entry.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-2 font-mono">
                      {entry.previous_plate} → {entry.new_plate}
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">
                      {entry.actor_display_name} ({entry.actor_username})
                      {entry.reason ? ` · ${entry.reason.replaceAll("_", " ")}` : ""}
                    </div>
                    {entry.notes && <div className="mt-2 text-sm">{entry.notes}</div>}
                  </div>
                ))}
              </div>
            )}
            {historyState.error && (
              <div role="alert" className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                {historyState.error}
              </div>
            )}
            <DialogFooter>
              {canBatchReview && historyState.entries.some((entry) =>
                ["confirm", "correct", "reject", "reopen"].includes(entry.action) &&
                  !entry.reversed
              ) && (
                <Button variant="outline" onClick={requestReverseReview}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reverse latest review
                </Button>
              )}
              <Button
                onClick={() =>
                  setHistoryState((current) => ({ ...current, open: false }))
                }
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={Boolean(aliasReplaceConflict)}
          onOpenChange={(open) => {
            if (!open) setAliasReplaceConflict(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace existing recurring alias?</AlertDialogTitle>
              <AlertDialogDescription>
                {aliasReplaceConflict?.sourcePlate} currently resolves to{" "}
                {aliasReplaceConflict?.targetPlate} for{" "}
                {aliasReplaceConflict?.cameraName
                  ? `camera ${aliasReplaceConflict.cameraName}`
                  : "all cameras"}
                . Replacing it will disable that alias and create a new mapping to{" "}
                {aliasReplaceConflict?.replacementTargetPlate}. The previous alias remains in
                the audit history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep existing alias</AlertDialogCancel>
              <AlertDialogAction onClick={() => handleCorrectSubmit({ replaceAlias: true })}>
                Replace alias
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={Boolean(reverseCandidate)}
          onOpenChange={(open) => {
            if (!open) setReverseCandidate(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Reverse latest plate review?</AlertDialogTitle>
              <AlertDialogDescription>
                This restores the read&apos;s previous effective plate and review status.
                {reverseCandidate?.related_alias_enabled
                  ? ` An active alias also maps ${reverseCandidate.related_alias_source_plate} to ${reverseCandidate.related_alias_target_plate}. Choose whether to disable it at the same time.`
                  : " No active recurring alias is associated with this review."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              {reverseCandidate?.related_alias_enabled ? (
                <>
                  <AlertDialogAction onClick={() => handleReverseReview()}>
                    Reverse only
                  </AlertDialogAction>
                  <AlertDialogAction
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => handleReverseReview({ disableAlias: true })}
                  >
                    Reverse and disable alias
                  </AlertDialogAction>
                </>
              ) : (
                <AlertDialogAction onClick={() => handleReverseReview()}>
                  Reverse review
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </div>
      </div>
    </TooltipProvider>
  );
}
