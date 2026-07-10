import { API } from 'nhentai-api';
import { escape } from 'querystring';
import { printError } from '@/utils/print';

const api = new API();

/**
 * nhentai搜索 (无法解决代理问题，暂不启用)
 */
export default async function nhentaiSearch(name: string) {
  console.log(name);

  const result = await api.search(escape(name)).catch((error) => {
    printError(`[nhentai Error] Fetch Error: ${error.message}`);
    return null;
  });
  if (result === null) {
    return {
      success: false,
      msg: '',
    };
  }

  const book = result.books[0];
  console.log(book);


  return {
    success: false,
    msg: '',
  };
}
