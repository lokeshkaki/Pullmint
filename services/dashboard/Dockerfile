FROM nginx:alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy custom config
COPY services/dashboard/nginx.conf /etc/nginx/conf.d/default.conf

# Copy static SPA files from dashboard-ui
COPY services/dashboard-ui/static/ /usr/share/nginx/html/

EXPOSE 80
