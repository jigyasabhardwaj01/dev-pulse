import type { Metadata } from "next";
import { Suspense } from "react";
import ReportContent from "@/components/ReportContent";
import ReportSkeleton from "@/components/ReportSkeleton";
import { requireKnownWeek } from "@/lib/page-guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Weekly report" };

export default async function ReportPage({ params }: { params: Promise<{ week: string }> }) {
  const { week } = await params;
  await requireKnownWeek(week);
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportContent week={week} mode="report" />
    </Suspense>
  );
}
