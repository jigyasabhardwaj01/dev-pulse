import { Suspense } from "react";
import ReportContent from "@/components/ReportContent";
import ReportSkeleton from "@/components/ReportSkeleton";
import { requireKnownWeek } from "@/lib/page-guard";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { week } = await searchParams;
  await requireKnownWeek(week);
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportContent week={week} mode="overview" />
    </Suspense>
  );
}
