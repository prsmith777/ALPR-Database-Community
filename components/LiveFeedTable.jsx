// components/LiveFeedTable.jsx
"use server";
import { Suspense } from "react";
import PlateTableClient from "./PlateTableClient";
import {
  getCameraNames,
  getLatestPlateReads,
  getSettings,
  getTags,
  getTimeFormat,
} from "@/app/actions";

export default async function LiveFeedTable(props) {
  const searchParams = await props.searchParams;

  const params = {
    page: parseInt(searchParams?.page || "1"),
    pageSize: parseInt(searchParams?.pageSize || "25"),
    search: searchParams?.search || "",
    matchMode:
      searchParams?.matchMode ||
      (searchParams?.fuzzySearch === "true" ? "balanced" : "default"),
    tag: searchParams?.tag || "all",
    dateRange:
      searchParams?.dateFrom && searchParams?.dateTo
        ? { from: searchParams.dateFrom, to: searchParams.dateTo }
        : null,
    hourRange:
      searchParams?.hourFrom && searchParams?.hourTo
        ? {
            from: parseInt(searchParams.hourFrom),
            to: parseInt(searchParams.hourTo),
          }
        : null,
    cameraName: searchParams?.camera,
  };

  const [platesRes, tagsRes, camerasRes, timeFormat, settings] = await Promise.all([
    getLatestPlateReads(params),
    getTags(),
    getCameraNames(),
    getTimeFormat(),
    getSettings(),
  ]);

  return (
    <Suspense fallback={<div>Loading...</div>}>
      <PlateTableClient
        data={platesRes.data}
        total={platesRes.pagination.total}
        tags={tagsRes.success ? tagsRes.data : []}
        cameras={camerasRes.success ? camerasRes.data : []}
        timeFormat={timeFormat}
        matchingSettings={settings.plateMatching}
      />
    </Suspense>
  );
}
