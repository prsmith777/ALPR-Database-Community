import { getPlateReads } from "@/lib/db";
import PlateTable from "@/components/PlateTable";
import { ThemeToggle } from "@/components/ThemeToggle";
import DashboardLayout from "@/components/layout/MainLayout";
import { redirect } from "next/navigation";

export default async function Home() {
  redirect("/dashboard");
}
