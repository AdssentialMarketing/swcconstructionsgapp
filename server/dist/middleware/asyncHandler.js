// Express 4 doesn't catch rejected promises from async route handlers —
// an uncaught rejection crashes the whole process (Node treats unhandled
// rejections as fatal by default). Wrap every handler with this so errors
// reach the error-handling middleware instead of taking the server down.
export function asyncHandler(fn) {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
}
