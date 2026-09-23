"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function LiveFeedSkeleton() {
  return (
    <Card>
      <CardContent className="py-4">
        {/* Controls skeleton */}
        <div className="flex flex-wrap justify-between items-center gap-4 mb-4">
          <div className="flex items-center space-x-2">
            <Skeleton className="h-10 w-64" /> {/* Search box */}
            <Skeleton className="h-10 w-40" /> {/* Fuzzy toggle */}
            <Skeleton className="h-10 w-[180px]" /> {/* Tag dropdown */}
            <Skeleton className="h-10 w-[180px]" /> {/* Camera dropdown */}
            <Skeleton className="h-10 w-32" /> {/* Date range */}
            <Skeleton className="h-10 w-32" /> {/* Hour range */}
          </div>
          <Skeleton className="h-10 w-40" /> {/* Page size selector */}
        </div>

        {/* Table skeleton */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">
                  <Skeleton className="h-4 w-16" />
                </TableHead>
                <TableHead className="w-32">
                  <Skeleton className="h-4 w-24" />
                </TableHead>
                <TableHead className="w-24">
                  <Skeleton className="h-4 w-16" />
                </TableHead>
                <TableHead className="w-40">
                  <Skeleton className="h-4 w-32" />
                </TableHead>
                <TableHead className="w-32">
                  <Skeleton className="h-4 w-24" />
                </TableHead>
                <TableHead className="w-40">
                  <Skeleton className="h-4 w-32" />
                </TableHead>
                <TableHead className="w-32">
                  <Skeleton className="h-4 w-24" />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array(5)
                .fill(null)
                .map((_, i) => (
                  <TableRow key={i}>
                    <TableCell>
                      <Skeleton className="h-[75px] w-[100px]" /> {/* Image */}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-24" /> {/* Plate number */}
                        <Skeleton className="h-3 w-16" /> {/* Known name */}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-8" /> {/* Occurrences */}
                    </TableCell>
                    <TableCell>
                      <div className="flex space-x-1">
                        <Skeleton className="h-6 w-16" />
                        <Skeleton className="h-6 w-16" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-20" /> {/* Camera */}
                    </TableCell>
                    <TableCell>
                      <Skeleton className="h-4 w-32" /> {/* Timestamp */}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end space-x-2">
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination skeleton */}
        <div className="flex items-center justify-between pt-4">
          <Skeleton className="h-4 w-64" /> {/* Results count */}
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20" /> {/* Previous button */}
            <Skeleton className="h-8 w-20" /> {/* Next button */}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
