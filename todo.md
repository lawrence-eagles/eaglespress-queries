// LIST OF THINGS TO DO

// BACKEND TODOS

1. Setup Redis ✅ Sort out Redis implementation
2. Get the rss inngest function ready with Redis ✅
3. Get all the db tables ready ✅
4. Get the personalized feed "for you" route ready ✅
5. Get the single post route ready ✅
6. Get the following route ready ✅
7. Get the trending route ready
8. Get the explore route ready
9. Get the Bookmark (view) ready
10. Get the videos route ready
11. Get the complete like route ready - featuring: like, post.score, user_behaviour.score
12. Get the complete post click (view) route ready - featuring: post.score, user_behaviour.score
13. Get the complete long read tracking route ready - featuring: post.score, user_behaviour.score
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
