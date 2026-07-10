import saucenaoSearch from './saucenao';
import whatAnimeSearch from './whatanime';
import ascii2dSearch from './ascii2d';
import { searchImageText } from './text';

const searchImage = async (imgUrls: string[]) => {
  const resultMsgs = [] as string[];
  try {
    for (const imgUrl of imgUrls) {
      let saucenaoSuccess = false;
      const ascii2dSuccess = false;
      // saucenao结果
      const result = await saucenaoSearch(imgUrl);
      saucenaoSuccess = result.success;
      // ascii2d结果
      let result2;

      // saucenao相似度
      const similarity = +(result.similarity ?? 0);

      // 相似度过低，或者saucenao失败时，追加ascii2d搜索
      // 暂时停用
      // if ((saucenaoSuccess && similarity < 58) || !saucenaoSuccess) {
      //   result2 = await ascii2dSearch(imgUrl);
      //   ascii2dSuccess = result2.success;
      // }

      // saucenao一级渠道搜索成功时，进行进一步的细分渠道搜索
      if (saucenaoSuccess) {
        if (result.msg.length > 0) {
          resultMsgs.push(result.msg);
        }
        if (result.isAnime) {
          // saucenao判断是动画，相似度66%以上，追加what anime搜索
          const whatAnimeRes = await whatAnimeSearch(imgUrl);
          if (whatAnimeRes.success && whatAnimeRes.msg.length > 0) {
            resultMsgs.push(whatAnimeRes.msg);
            if (whatAnimeRes.extraMsg) {
              resultMsgs.push(whatAnimeRes.extraMsg);
            }
          }
        }
      }

      // ascii2d搜索成功时，加入搜索结果
      if (ascii2dSuccess && result2?.msg && result2.msg.length > 0) {
        resultMsgs.push(result2.msg);
      }
    }

    // 返回msg数组
    if (resultMsgs.length > 0) {
      return resultMsgs;
    }
    // 为空时返回兜底文案
    return [searchImageText.error];
  } catch (err) {
    console.error(`${new Date().toLocaleString()} [searchImage Error]\n${err}`);
    return [searchImageText.error];
  }
};

export default searchImage;


/*
if (result.isBook) {
  // 是动画，返回本子搜索文本，兜底为saucenao
  const nhentaiRes = await nhentaiSearch(result.details.jp_name || '');
  if (nhentaiRes.success && nhentaiRes.msg.length > 0) {
    resultMsgs.push(nhentaiRes.msg)
  } else if (result.msg.length > 0) {
    resultMsgs.push(result.msg);
  }
}
*/
