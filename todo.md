// LIST OF THINGS TO DO

// BACKEND TODOS

1. Setup Redis ✅ Sort out Redis implementation
2. Get the rss inngest function ready with Redis ✅
3. Get all the db tables ready ✅
4. Get the personalized feed "for you" route ready ✅
5. Get the single post route ready ✅
6. Get the following route ready ✅
7. Get the trending route ready ✅
8. Get the explore route ready
9. Get the Bookmark (view) ready
10. Get the videos route ready // I WILL NOT BE ROLLING THIS OUT AS I LUNCH.
11. Get the complete like route ready - featuring: like, post.score, user_behaviour.score
12. Get the complete post click (view) route ready - featuring: post.score, user_behaviour.score
13. Get the complete long read tracking route ready - featuring: post.score, user_behaviour.score // NO NEED FOR THIS ROUTE.
14. Get the complete Bookmark route (to save a post) ready - featuring: post.score, user_behaviour.score
15. Get the complete Comment route ready -featuring: post.score, user_behaviour.score
16. Get the complete sharing route ready - featuring: post.score, user_behaviour.score
17. Get the user onboarding route ready - to enable users select category of choice
18. Get better auth setup completely - email/password, google authentication, forget password, and maybe email verification
19. Get the interest route - this route displays the list of all categories and enables the user to follow or unfollow a category as he/she wills
20. Generate a list of categories and their lookup keywords for Eaglespress

// CLAUDE PROMPTING ALWAYS REMEMBER TO TELL IT TO USE NODE-REDIS, use axios through out,

// WHAT EACH POST IN THE POST FEED CONTAINS (POSTS IN THE TRENDING, BOOKMARK, FOLLOWING USE THIS FORMAT)

1. Title
2. Slug
3. Image
4. Source Name
5. Source URL
6. Category Name
7. Publication date
8. isLike to know if the current user already like the post
9. Total number of likes
10. Total number of comments
11. isBookmarked to know if the current user already bookmark the post

// WHAT A SINGLE POST CONTAINS

1. Title
2. Slug
3. Image
4. Source Name
5. Source URL
6. Category Name
7. Publication date
8. isLIke to know if the current user already like the post
9. Total number of likes
10. isBookmarked to know if the current user already bookmark the post
11. isFollow to know if the current user follow the category
12. Total number of users following that category
<!-- 13. Return all comments for that post including their replies -->
13. Total number of comments that post have
14. update post.count by 2
15. update user_behaviour.count by 2

// NOTE COMMENT HAVE THEIR OWN TABLE AND YOU TIE THEM TO POSTS USING QUERY STRING. IN THE FRONTEND YOU MAKE TWO API REQUEST WHEN YOU FETCH A POST AND ITS COMMENTS.

<!-- useEffect(() => {
  fetch(`/api/posts/${postId}`)
    .then(res => res.json())
    .then(setPost);

  fetch(`/api/comments?postId=${postId}`)
    .then(res => res.json())
    .then(setComments);
}, [postId]); -->

// IMPORTAND WARNING
// ⚠️ FINAL ARCHITECTURE NOTE (IMPORTANT)
// Right now you are doing:
// DB = source of truth ✅
// Redis = real-time counter ⚠️
// Feed cache = derived data ⚠️
// This means:
// 👉 Feed MUST always be invalidated on:
// like
// comment
// follow
// post creation
// Otherwise ranking becomes incorrect.

// THE MENU ITEMS:
// FOR YOU ✅
// TRENDING ✅
// EXPLORE
// HEADLINES ✅
// BOOKMARK ✅

✅ Invalidate feed cache on new bookmark / post / like
✅ Merge Redis + DB counts (real-time feeds)
✅ versioned cache invalidation

// TOMORROW
// NOTE USE REDIS PIPELINE multi() in node-redis FORE LIKE/UNLIKE, BOOKMARK/UNBOOKMARK, FOLLOW/UNFOLLOW

1. CHECK IF SINGLE POST CORRECTLY WORK WITH THE CACHE FUNCTION IN CACHE.TS ✅
2. ASK IF SCRAPER.TS SUPPORT VERSIONED CACHE INVALIDAION AND IF IT WORKS WITH MY CACHE FUNCTION IN CACHE.TS ✅
3. UPDATE LIKE.TS TO WORK WITH MY NEW CACHE.TS CACHE. ✅
4. LET CHATGPT REVIEW ALL CODES.
5. BOOKMARK ROUTE TO HANDLE BOOKMARK AND UNBOOKMARK POST - IT SHOULD WORK WITH CACHE.TS
6. BUILD COMMENT ROUTES
7. MAKE SURE CACHE IS INVALIDATED WHEN A USER CREATE, UPDATE OR DELETE A COMMENT
8. BUILD EXPLORE ROUTE - HANDLE FOLLOW AND UNFOLLOW CATEGORY, MAKE SURE CACHE IS INVALIDATED PROPERLY
9. PUT EVERYTHING TOGETHER IN A DEMO CALLED EAGLESTELEGRAM USING NEON AND RENDER
10. FIX ALL BUGS.
11. REDEPLOY TO RAILWAY --- BACKEND DONE ✅
