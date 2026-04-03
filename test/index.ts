import nnkbot from '@/core/nnkBot';
import nnkSchedule from '@/core/nnkSchedule';
import Axios from 'axios';

import { printError } from '@/utils/print';
import { createScreenshot } from '@/service/twitter/screenshot';
import { getLatestTweet, getTweetPost } from '@/service/twitter/tweet';
import { createMsgFromTweetId } from '@/tasks/twitter';
import getMessageCode, { extractCQCodes } from '@/utils/msgCode';
import { startTransfer } from '@/modules/group/ykhr/transfer';
import { testAI } from './ai';

// console.log(await createMsgFromTweetId('2024011099478122755'));

// getLatestTweet('Cho_KaguyaHime').then((res) => console.log(res));

testAI()