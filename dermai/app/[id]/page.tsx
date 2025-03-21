import Chat from "@/app/page";

export default async function Page({ params }: { params: { id: string } }) {
  const { id } = await params;
  return <Chat id={id} />;
}
