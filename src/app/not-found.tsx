import EmptyState from "@/components/EmptyState";

export default function NotFound() {
  return <EmptyState title="We couldn't find that" body="That report or page doesn't exist." action={{ href: "/", label: "Go to this week's report" }} />;
}
