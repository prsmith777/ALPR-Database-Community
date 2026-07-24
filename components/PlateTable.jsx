"use client";

import { useState, useEffect, useRef } from "react";
import NextImage from "next/image";
import Link from "next/link";
import {
  Search,
  Filter,
  Tag,
  Plus,
  Trash2,
  X,
  CalendarDays,
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
  ChevronRight,
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Calendar } from "@/components/ui/calendar";
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
import { getSettings } from "@/app/actions";
import ImageViewer from "./ImageViewer";
import { useAccess } from "@/components/auth/AccessProvider";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SheetFooter,
} from "@/components/ui/sheet";

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
  onCorrectPlate,
  onPreviewCorrection,
  onReviewHistory,
  onReverseReview,
  timeFormat = 12,
  sort = { field: "", direction: "" },
  onSort = () => {},
  matchingSettings,
}) {
  console.log("PlateTable rendering with data:", data.length);

  const { can } = useAccess();
  const canRead = can("plate.read");
  const canReview = can("plate.review");
  const canBatchReview = can("plate.review.batch");
  const canManageAliases = can("plate.alias.manage");
  const canDelete = can("plate.delete");
  const canManageKnownPlates = can("known_plate.manage");
  const canManageTags = can("tag.manage");
  const canExport = can("export.create");
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

  // Only keep state for modals and temporary form data
  const [isAddKnownPlateOpen, setIsAddKnownPlateOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [activePlate, setActivePlate] = useState(null);
  const [newKnownPlate, setNewKnownPlate] = useState({ name: "", notes: "" });
  const [correction, setCorrection] = useState(null);
  const [isCorrectPlateOpen, setIsCorrectPlateOpen] = useState(false);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionPreview, setCorrectionPreview] = useState(null);
  const [historyState, setHistoryState] = useState({
    open: false,
    read: null,
    loading: false,
    entries: [],
    error: "",
  });
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [searchInput, setSearchInput] = useState(filters.search || "");
  const [isLive, setIsLive] = useState(true);
  const [prefetchedImages, setPrefetchedImages] = useState(new Set());
  const [biHost, setBiHost] = useState(null);
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const [isSearchOptionsOpen, setIsSearchOptionsOpen] = useState(false);

  //zoom/crop stuff
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const imageContainerRef = useRef(null);
  const correctionInputRef = useRef(null);

  const router = useRouter();

  // Cycle through images without clicking out with arrow keys
  const handleKeyPress = (e) => {
    // Don't handle arrow keys if any input element is focused
    if (
      document.activeElement?.tagName === "INPUT" ||
      document.activeElement?.tagName === "TEXTAREA"
    ) {
      return;
    }

    if (selectedImage === null) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      const nextIndex = (selectedIndex + 1) % data.length;
      const nextPlate = data[nextIndex];
      handleImageClick(e, nextPlate);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prevIndex =
        selectedIndex <= 0 ? data.length - 1 : selectedIndex - 1;
      const prevPlate = data[prevIndex];
      handleImageClick(e, prevPlate);
    }
  };

  // Add keyboard listener when modal is open
  useEffect(() => {
    if (selectedImage) {
      window.addEventListener("keydown", handleKeyPress);
      return () => window.removeEventListener("keydown", handleKeyPress);
    }
  }, [selectedImage, selectedIndex, data]);

  useEffect(() => {
    async function fetchBiHost() {
      const config = await getSettings();
      console.log(config.blueiris.host);
      if (config?.blueiris?.host) {
        setBiHost(config.blueiris.host);
      }
    }
    fetchBiHost();
  }, []);

  useEffect(() => {
    let interval;
    if (isLive) {
      interval = setInterval(() => {
        router.refresh();
      }, 4500);
    }
    return () => clearInterval(interval);
  }, [isLive, router]);

  // Helper functions
  const getImageUrl = (base64Data) => {
    if (!base64Data) return "/placeholder-image.jpg";
    if (base64Data.startsWith("data:image/jpeg;base64,")) return base64Data;
    return `data:image/jpeg;base64,${base64Data}`;
  };

  const handleImageClick = (e, plate) => {
    e.preventDefault();
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

    setSelectedIndex(plateIndex);
    setSelectedImage({
      url: imageUrl,
      thumbnail: thumbnailUrl,
      plateNumber: plate.plate_number,
      observedPlate: plate.observed_plate || plate.plate_number,
      reviewStatus: plate.review_status || (plate.validated ? "confirmed" : "unreviewed"),
      reviewRevision: plate.review_revision || 0,
      appliedAliasId: plate.applied_alias_id || null,
      cameraName: plate.camera_name || "",
      id: plate.id,
      validated: plate.validated,
      bi_path: bi_url,
      crop_coordinates: plate.crop_coordinates,
    });

    // Reset zoom and position when opening new image
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const handleNextImage = () => {
    if (!selectedImage || data.length <= 1) return;
    const nextIndex = (selectedIndex + 1) % data.length;
    handleImageClick({ preventDefault: () => {} }, data[nextIndex]);
  };

  useEffect(() => {
    if (selectedImage && data && data.length > 0) {
      const currentPlate = data.find((plate) => plate.id === selectedImage.id);

      if (
        currentPlate &&
        (currentPlate.validated !== selectedImage.validated ||
          currentPlate.plate_number !== selectedImage.plateNumber ||
          currentPlate.review_status !== selectedImage.reviewStatus ||
          currentPlate.review_revision !== selectedImage.reviewRevision)
      ) {
        setSelectedImage((previous) => ({
          ...previous,
          validated: currentPlate.validated,
          plateNumber: currentPlate.plate_number,
          observedPlate: currentPlate.observed_plate || currentPlate.plate_number,
          reviewStatus:
            currentPlate.review_status ||
            (currentPlate.validated ? "confirmed" : "unreviewed"),
          reviewRevision: currentPlate.review_revision || 0,
        }));
      }
    }
  }, [data, selectedImage]);

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

  useEffect(() => {
    // Only prefetch if we have data and aren't loading
    if (!loading && data?.length > 0) {
      data.forEach((plate) => {
        if (plate.image_path && !prefetchedImages.has(plate.image_path)) {
          const fullImageUrl = `/images/${plate.image_path}`;
          // Create a new Image to prefetch
          const img = new Image();
          img.src = fullImageUrl;
          setPrefetchedImages((prev) => new Set([...prev, plate.image_path]));
        }
      });
    }
  }, [data, loading]);

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

  const handleDateRangeSelect = (range) => {
    onUpdateFilters({
      dateFrom: range.from ? range.from.toDateString() : null,
      dateTo: range.to ? range.to.toDateString() : null,
    });
  };

  const handlePageSizeChange = (value) => {
    onUpdateFilters({ pageSize: value });
  };

  const handleAddKnownPlateSubmit = async () => {
    if (!activePlate) return;
    await onAddKnownPlate(
      activePlate.plate_number,
      newKnownPlate.name,
      newKnownPlate.notes
    );
    setIsAddKnownPlateOpen(false);
    setNewKnownPlate({ name: "", notes: "" });
  };

  const handleDeleteSubmit = async () => {
    if (!activePlate) return;
    await onDeleteRecord(activePlate.id); //fix use id
    setIsDeleteConfirmOpen(false);
  };

  const correctionFormData = () => {
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
    formData.append("reason", correction.reason);
    formData.append("notes", correction.notes);
    return formData;
  };

  const handleCorrectSubmit = async () => {
    if (!correction) return;
    setCorrectionError("");
    const result = await onCorrectPlate(correctionFormData());
    if (!result?.success) {
      setCorrectionError(result?.error || "Unable to correct this plate read.");
      return;
    }
    if (result.warning) window.alert(result.warning);
    if (selectedImage) {
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

  const handleReverseReview = async () => {
    if (!historyState.read) return;
    const formData = new FormData();
    formData.append("readId", historyState.read.id);
    formData.append("reason", "administrator_reversal");
    const result = await onReverseReview(formData);
    if (!result?.success) {
      setHistoryState((current) => ({ ...current, error: result?.error || "Unable to reverse review." }));
      return;
    }
    await openReviewHistory(historyState.read);
  };

  const clearFilters = () => {
    setSearchInput("");
    onUpdateFilters({
      search: "",
      fuzzySearch: null,
      tag: null,
      dateFrom: null,
      dateTo: null,
      hourFrom: null,
      hourTo: null,
      camera: null,
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

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Date Range</h4>
        <Calendar
          mode="range"
          defaultMonth={filters.dateRange?.from}
          selected={{
            from: filters.dateRange?.from,
            to: filters.dateRange?.to,
          }}
          onSelect={(range) => {
            onUpdateFilters({
              dateFrom: range?.from ? range.from.toDateString() : null,
              dateTo: range?.to ? range.to.toDateString() : null,
            });
          }}
          className="rounded-md border"
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
                  onCheckedChange={setIsLive}
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
                  placeholder="Search plates..."
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

              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="hidden sm:flex gap-2 dark:bg-[#161618]"
                  >
                    <CalendarDays className="h-4 w-4" />
                    {filters.dateRange.from ? (
                      filters.dateRange.to ? (
                        <>
                          {format(filters.dateRange.from, "LLL dd")} -{" "}
                          {format(filters.dateRange.to, "LLL dd")}
                        </>
                      ) : (
                        format(filters.dateRange.from, "LLL dd")
                      )
                    ) : (
                      "Date Range"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="max-h-[var(--radix-popover-content-available-height)] w-auto overflow-y-auto overscroll-contain p-0"
                  align="start"
                  collisionPadding={16}
                  sticky="always"
                >
                  <Calendar
                    initialFocus
                    mode="range"
                    defaultMonth={filters.dateRange?.from}
                    selected={{
                      from: filters.dateRange?.from,
                      to: filters.dateRange?.to,
                    }}
                    onSelect={(range) => {
                      onUpdateFilters({
                        dateFrom: range.from ? range.from.toDateString() : null,
                        dateTo: range.to ? range.to.toDateString() : null,
                      });
                    }}
                    numberOfMonths={2}
                  />
                </PopoverContent>
              </Popover>

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
              {(filters.search ||
                selectedTags.length > 0 ||
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

        {/* Active filters display on mobile */}
        {(filters.search ||
          selectedTags.length > 0 ||
          filters.dateRange.from ||
          selectedCameras.length > 0 ||
          (filters.hourRange?.from !== undefined &&
            filters.hourRange?.to !== undefined)) && (
          <div className="flex sm:hidden items-center gap-2 mb-4 overflow-x-auto pb-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              Active filters:
            </span>

            {filters.search && (
              <Badge
                variant="outline"
                className="text-xs h-6 whitespace-nowrap"
              >
                Search: {filters.search}
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
                  <TableHead className="w-18 sm:w-40">Tags</TableHead>
                  <TableHead className="w-32 hidden sm:table-cell">
                    <SortButton
                      label="Camera"
                      field="camera_name"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-24 sm:w-40">
                    <SortButton
                      label="Timestamp"
                      field="timestamp"
                      sort={sort}
                      onSort={onSort}
                    />
                  </TableHead>
                  <TableHead className="w-32 text-right hidden sm:table-cell">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-4">
                      Loading...
                    </TableCell>
                  </TableRow>
                ) : data.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-4">
                      No results found
                    </TableCell>
                  </TableRow>
                ) : (
                  data.map((plate) => (
                    <TableRow key={plate.id}>
                      <TableCell>
                        <PlateImage
                          plate={plate}
                          onClick={(e) => handleImageClick(e, plate)}
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
                      <TableCell className="text-xs sm:text-sm">
                        {new Date(plate.timestamp).toLocaleString("en-US", {
                          hour12: timeFormat === 12,
                        })}
                      </TableCell>

                      <TableCell className="hidden sm:table-cell">
                        <div className="flex space-x-2 justify-end">
                          {canManageTags && <DropdownMenu>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="icon"
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
                                aria-label={`Correct plate ${plate.plate_number}`}
                                onClick={() => {
                                  setCorrection({
                                    id: plate.id,
                                    plateNumber: plate.plate_number,
                                    observedPlate: plate.observed_plate || plate.plate_number,
                                    cameraName: plate.camera_name || "",
                                    newPlateNumber: plate.plate_number,
                                    correctAll: false,
                                    unreviewedOnly: true,
                                    batchCameraOnly: false,
                                    rememberAlias: false,
                                    aliasScope: "camera",
                                    reason: "ocr_character_error",
                                    notes: "",
                                  });
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
                                aria-label={`Review history for ${plate.plate_number}`}
                                onClick={() => openReviewHistory(plate)}
                              >
                                <History className="h-4 w-4" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Review history</TooltipContent>
                          </Tooltip>}
                          {biHost && plate.bi_path ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Open ${plate.plate_number} in Blue Iris`}
                                  onClick={() =>
                                    window.open(
                                      `http://${biHost}/${plate.bi_path}`,
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
                          {canReview && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`${
                                  plate?.validated ? "Reopen review for" : "Confirm detected plate"
                                } ${plate.plate_number}`}
                                className={
                                  plate?.validated
                                    ? "text-green-500 hover:text-green-700"
                                    : ""
                                }
                                onClick={() => {
                                  onValidate(plate.id, !plate.validated);
                                }}
                              >
                                {plate?.validated ? (
                                  <CircleCheck className="h-4 w-4" />
                                ) : (
                                  <Check className="h-4 w-4" />
                                )}
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                              {plate?.validated
                                ? "Reopen review"
                                : "Confirm detected plate"}
                            </TooltipContent>
                          </Tooltip>}

                          {canDelete && <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-red-500 hover:text-red-700"
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
                {data.map((plate) => (
                  <div key={plate.id} className="p-3">
                    <div className="flex items-start gap-3">
                      {/* Image and basic info */}
                      <div className="flex-shrink-0" style={{ width: "80px" }}>
                        <PlateImage
                          plate={plate}
                          onClick={(e) => handleImageClick(e, plate)}
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
                                  setCorrection({
                                    id: plate.id,
                                    plateNumber: plate.plate_number,
                                    observedPlate: plate.observed_plate || plate.plate_number,
                                    cameraName: plate.camera_name || "",
                                    newPlateNumber: plate.plate_number,
                                    correctAll: false,
                                    unreviewedOnly: true,
                                    batchCameraOnly: false,
                                    rememberAlias: false,
                                    aliasScope: "camera",
                                    reason: "ocr_character_error",
                                    notes: "",
                                  });
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
                              {biHost && plate.bi_path ? (
                                <DropdownMenuItem
                                  onClick={() =>
                                    window.open(
                                      `http://${biHost}/${plate.bi_path}`,
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
                            <span className="font-medium">Occurrences: </span>
                            {plate.occurrence_count}
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

        {/* Pagination - Mobile & Desktop */}
        <div className="flex items-center justify-between pt-4">
          <div className="text-xs sm:text-sm text-muted-foreground">
            {pagination.total > 0 ? (
              <>
                Showing {(pagination.page - 1) * pagination.pageSize + 1} to{" "}
                {Math.min(
                  pagination.page * pagination.pageSize,
                  pagination.total
                )}{" "}
                of {pagination.total} results
              </>
            ) : (
              "No results"
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={pagination.onPreviousPage}
              disabled={pagination.page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="dark:bg-[#161618]"
              onClick={pagination.onNextPage}
              disabled={
                pagination.page * pagination.pageSize >= pagination.total
              }
            >
              Next
            </Button>
          </div>
        </div>

        {/* Modals - These work on both mobile and desktop */}
        <Dialog
          open={selectedImage !== null}
          onOpenChange={(open) => {
            if (!open) {
              setSelectedImage(null);
              setSelectedIndex(-1);
            }
          }}
        >
          <DialogContent className="max-h-[calc(100vh-2rem)] w-[calc(100vw-32px)] max-w-7xl overflow-y-auto sm:h-[calc(100vh-2rem)] sm:w-2/3 sm:max-w-7xl sm:grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:overflow-hidden">
            <DialogHeader>
              <DialogTitle>
                License Plate Image - {selectedImage?.plateNumber}
              </DialogTitle>
            </DialogHeader>
            {selectedImage && (
              <div className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3">
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Observed</div>
                  <div className="font-mono">{selectedImage.observedPlate}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Effective</div>
                  <div className="font-mono">{selectedImage.plateNumber}</div>
                </div>
                <div>
                  <div className="text-xs uppercase text-muted-foreground">Review status</div>
                  <div>{REVIEW_STATUS_LABELS[selectedImage.reviewStatus] || selectedImage.reviewStatus}</div>
                </div>
              </div>
            )}
            <div className="relative h-[40vh] w-full sm:h-auto sm:min-h-0">
              {selectedImage && (
                <ImageViewer
                  image={selectedImage}
                  onClose={() => setSelectedImage(null)}
                />
              )}
            </div>
            <DialogFooter>
              <div className="flex w-full flex-wrap gap-2">
                <div className="contents">
                  {canRead && selectedImage && <Button asChild variant="outline" size="sm" className="text-xs sm:text-sm">
                    <Link href={`/visual_search?readId=${selectedImage.id}`}>
                      <ScanSearch className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                      <span className="whitespace-nowrap">Find similar vehicle</span>
                    </Link>
                  </Button>}
                  {canReview && <Button
                    variant="outline"
                    size="sm"
                    className="text-xs sm:text-sm"
                    onClick={() => {
                      setCorrection({
                        id: selectedImage.id,
                        plateNumber: selectedImage.plateNumber,
                        observedPlate: selectedImage.observedPlate || selectedImage.plateNumber,
                        cameraName: selectedImage.cameraName || "",
                        newPlateNumber: selectedImage.plateNumber,
                        correctAll: false,
                        unreviewedOnly: true,
                        batchCameraOnly: false,
                        rememberAlias: false,
                        aliasScope: "camera",
                        reason: "ocr_character_error",
                        notes: "",
                      });
                      setIsCorrectPlateOpen(true);
                    }}
                  >
                    <Edit className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    <span className="whitespace-nowrap">Correct Plate</span>
                  </Button>}
                  {canRead && <Button
                    variant="outline"
                    size="sm"
                    className="text-xs sm:text-sm"
                    onClick={() => openReviewHistory({
                      id: selectedImage.id,
                      plate_number: selectedImage.plateNumber,
                      observed_plate: selectedImage.observedPlate,
                    })}
                  >
                    <History className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    <span className="whitespace-nowrap">Review History</span>
                  </Button>}
                  {canManageKnownPlates && <Button
                    variant="outline"
                    size="sm"
                    className="text-xs sm:text-sm"
                    onClick={() => {
                      setActivePlate({
                        ...selectedImage,
                        plate_number: selectedImage.plateNumber,
                      });
                      setIsAddKnownPlateOpen(true);
                    }}
                  >
                    <Plus className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    <span className="whitespace-nowrap">Add to Known</span>
                  </Button>}
                  {canManageTags && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs sm:text-sm"
                      >
                        <Tag className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                        Add Tag
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      {availableTags.map((tag) => (
                        <DropdownMenuItem
                          key={tag.name}
                          onClick={() =>
                            onAddTag(selectedImage.plateNumber, tag.name)
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
                  <div className="flex shrink-0 gap-2">
                    {canReview && <Button
                      variant="outline"
                      size="sm"
                      className={
                        selectedImage?.validated
                          ? "text-xs sm:text-sm text-green-500"
                          : "text-xs sm:text-sm"
                      }
                      onClick={() => {
                        onValidate(selectedImage.id, !selectedImage.validated);
                      }}
                    >
                      <Check className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                      <span className="whitespace-nowrap">{selectedImage?.validated ? "Reopen review" : "Confirm detected plate"}</span>
                    </Button>}
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs sm:text-sm"
                      onClick={handleNextImage}
                      disabled={data.length <= 1}
                      aria-label="Show next read in the current Live Feed list"
                      title="Show next read (Right Arrow)"
                    >
                      <span className="whitespace-nowrap">Next read</span>
                      <ChevronRight className="ml-1 h-3 w-3 sm:ml-2 sm:h-4 sm:w-4" />
                    </Button>
                  </div>
                </div>
                <div className="ml-auto flex gap-2">
                  {biHost && selectedImage?.bi_path && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs sm:text-sm"
                      onClick={() =>
                        window.open(
                          `http://${biHost}/${selectedImage.bi_path}`,
                          "_blank"
                        )
                      }
                    >
                      <ExternalLink className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                      <span className="whitespace-nowrap">Blue Iris</span>
                    </Button>
                  )}
                  {canExport && <Button
                    variant="outline"
                    size="sm"
                    className="text-xs sm:text-sm"
                    onClick={handleDownloadImage}
                  >
                    <Download className="h-3 w-3 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
                    <span className="whitespace-nowrap">Download</span>
                  </Button>}
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
                  selectedImage?.id === correction?.id
                    ? "grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
                    : "grid gap-4"
                }
              >
                {selectedImage?.id === correction?.id && (
                  <div className="grid gap-2">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Plate image
                    </div>
                    <div className="relative h-56 overflow-hidden rounded-lg border bg-black p-2">
                      <ImageViewer image={selectedImage} />
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
                      onChange={(event) =>
                        setCorrection((current) => ({
                          ...current,
                          newPlateNumber: event.target.value.toUpperCase(),
                        }))
                      }
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

              {canBatchReview && (
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
                onClick={handleCorrectSubmit}
                disabled={
                  !correction?.newPlateNumber ||
                  correction.newPlateNumber === correction.plateNumber ||
                  (correction.correctAll && !correctionPreview)
                }
              >
                {correction?.correctAll ? "Apply previewed batch" : "Correct this read"}
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
                ["confirm", "correct", "reject", "reopen"].includes(entry.action)
              ) && (
                <Button variant="outline" onClick={handleReverseReview}>
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
        </div>
      </div>
    </TooltipProvider>
  );
}
