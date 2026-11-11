import { CaseWorkbench } from "@/components/CaseWorkbench";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CaseWorkbench caseId={id} />;
}
