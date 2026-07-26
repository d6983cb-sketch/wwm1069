import SiteFooter from "@/app/components/SiteFooter";
import SiteHeader from "@/app/components/SiteHeader";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const rules = [
  ["一、活動主題", "投稿自己在遊戲中 Cos 的人物、NPC、門派角色或其他遊戲角色，並附上角色來源遊戲。"],
  ["二、投稿規則", "每人限投稿一件作品。投稿作品須為本人拍攝，禁止盜圖、禁止 AI 生成人物。AI 合成背景可使用，但需提供原圖供管理員查核。可適度修圖，但不得影響角色辨識；投稿完成後不得修改。"],
  ["三、投票方式", "每位玩家共有五票，每件作品最多只能投一票，可自由分配五票。投票截止後依票數排名。"],
  ["四、禁止私下拉票", "禁止私訊請求投票、建立私人群組集中拉票、利益交換、互投或請他人代拉票。若造成他人困擾，請提供聊天截圖；經管理員查證後取消參賽資格。請不要因為獎勵破壞得來不易的友情。"],
];

export default async function RulesPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: profile } = user ? await createAdminClient().from("profiles").select("nickname").eq("id", user.id).maybeSingle() : { data: null };
  return <>
    <SiteHeader nickname={profile?.nickname} />
    <main className="inner">
      <header className="page-title"><small>RULES · 活動章程</small><h1>以作品相會，以公正成名</h1><p>投稿與投票前，請完整閱讀以下規則。</p></header>
      <section className="rules"><aside><i>公</i><h2>公平參與</h2><p>請不要因為獎勵，破壞得來不易的友情。</p></aside><div>{rules.map(([title, copy]) => <article key={title}><h2>{title}</h2><p>{copy}</p></article>)}</div></section>
    </main>
    <SiteFooter />
  </>;
}
