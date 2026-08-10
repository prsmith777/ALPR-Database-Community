// app/dashboard/plates/page.jsx
import {
  getPlateViewSettings,
  getLatestPlateReads,
  getTags,
  getCameraNames,
  getDirectionLabels,
  getTimeFormat,
} from "@/app/actions";

import PlateTableWrapper from "@/components/PlateTableWrapper"; // Correct path to wrapper
import DashboardLayout from "@/components/layout/MainLayout";
import BasicTitle from "@/components/layout/BasicTitle";
import { Suspense } from "react";
import LiveFeedSkeleton from "@/components/LiveFeedSkeleton";
import Link from "next/link";
import TitleNavbar from "@/components/layout/LiveFeedNav";

import { Button } from "@/components/ui/button";
import { unstable_noStore as noStore } from "next/cache";
import { requirePagePermission } from "@/lib/page-permission.mjs";
import {
  DASHBOARD_FEED_METRIC_LABELS,
  DASHBOARD_TIME_FRAME_LABELS,
  normalizeDashboardTimeZone,
} from "@/lib/dashboard-time-distribution.mjs";

export const dynamic = "force-dynamic"; // Ensures data is fetched on every request

function searchParamList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return value ? [value] : [];
}

function timestampRange(from, to) {
  const start = new Date(from || "");
  const end = new Date(to || "");
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start >= end
  ) {
    return null;
  }
  return { from: start.toISOString(), to: end.toISOString() };
}

export default async function LivePlates(props) {
  await requirePagePermission("plate.read");
  noStore(); // Opt-out of data caching for this component and its data fetches

  const searchParams = await props.searchParams;
  const dashboardTimestampRange = timestampRange(
    searchParams?.timestampFrom,
    searchParams?.timestampTo
  );
  const dashboardTimeFrame = DASHBOARD_TIME_FRAME_LABELS[searchParams?.timeFrame]
    ? searchParams.timeFrame
    : "";
  const dashboardMetric = dashboardTimestampRange &&
    DASHBOARD_FEED_METRIC_LABELS[searchParams?.dashboardMetric]
    ? searchParams.dashboardMetric
    : "";

  const params = {
    page: parseInt(searchParams?.page || "1"),
    pageSize: parseInt(searchParams?.pageSize || "25"),
    search: searchParams?.search || "",
    matchMode:
      searchParams?.matchMode ||
      "balanced",
    tags: searchParamList(searchParams?.tag).filter((tag) => tag !== "all"),
    dateRange:
      searchParams?.dateFrom && searchParams?.dateTo
        ? { from: searchParams.dateFrom, to: searchParams.dateTo }
        : null,
    timestampRange: dashboardTimestampRange,
    hourRange:
      searchParams?.hourFrom && searchParams?.hourTo
        ? {
            from: parseInt(searchParams.hourFrom),
            to: parseInt(searchParams.hourTo),
          }
        : null,
    cameraNames: searchParamList(searchParams?.camera),
    timeZone: dashboardTimestampRange
      ? normalizeDashboardTimeZone(searchParams?.timeZone)
      : "",
    reviewStatuses: searchParamList(searchParams?.reviewStatus),
    directionLabels: searchParamList(searchParams?.direction),
    dashboardMetric,
    sortField: searchParams?.sortField,
    sortDirection: searchParams?.sortDirection,
  };

  const [platesRes, tagsRes, camerasRes, directionsRes, timeFormat, config] =
    await Promise.all([
      getLatestPlateReads(params),
      getTags(),
      getCameraNames(),
      getDirectionLabels(),
      getTimeFormat(),
      getPlateViewSettings(),
    ]);

  return (
    <DashboardLayout>
      <TitleNavbar title="ALPR Recognition Feed">
        <Suspense fallback={<LiveFeedSkeleton />}>
          <PlateTableWrapper
            data={platesRes.data}
            total={platesRes.pagination.total}
            tags={tagsRes.success ? tagsRes.data : []}
            cameras={camerasRes.success ? camerasRes.data : []}
            directions={directionsRes.success ? directionsRes.data : []}
            timeFormat={timeFormat}
            biHost={config?.blueiris?.host}
            matchingSettings={config?.plateMatching}
            dashboardTimeFrame={dashboardTimeFrame}
            dashboardMetric={dashboardMetric}
          />
        </Suspense>
      </TitleNavbar>
    </DashboardLayout>
  );
}
