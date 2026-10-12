import { Suspense } from "react";
import { notFound } from "next/navigation";
import ReportContent from "@/components/ReportContent";
import ReportSkeleton from "@/components/ReportSkeleton";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const { week } = await searchParams;
  // Validated BEFORE any Suspense boundary, so a malformed week is a real HTTP 404 rather than a streamed 200.
  if (week !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(week)) notFound();
  return (
    <Suspense fallback={<ReportSkeleton />}>
      <ReportContent week={week} />
    </Suspense>
  );
}
