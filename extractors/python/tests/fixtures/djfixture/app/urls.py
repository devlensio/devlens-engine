from django.urls import path
from . import views

urlpatterns = [
    path("posts/", views.list_posts, name="list_posts"),
    path("posts/<int:pk>/", views.post_detail, name="post_detail"),
]
