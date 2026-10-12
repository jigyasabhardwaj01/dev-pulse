import EmptyState from "@/components/EmptyState";

export default function NotFound() {
  return <EmptyState title="We couldn't find that" body="That report or page doesn't exist. Reports are named by the Friday their week begins, so check the list for the weeks that were saved." action={{ href: "/reports", label: "See all weekly reports" }} />;
}
